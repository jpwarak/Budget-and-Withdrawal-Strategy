// ════════════════════════════════════════════════════════════════════════
// engine.js -- the calculation engine, physically split out of
// withdrawal_strategy_JP.html (Priority 16, Phase 2).
//
// This file holds the ~100 pure calculation functions (tax, CPP/QPP, OAS,
// RRSP/RRIF/LIF rules, the three simulateXXX() retirement simulators, Monte
// Carlo, reverse-sequence testing, etc.) plus the tax/benefit constant
// tables they use, extracted unchanged from the "Simulation engine" section
// of the main file. It is loaded via a plain <script src="engine.js"></script>
// tag before the main inline <script>, so everything declared here (via
// function/const/let at top level) is an ordinary global, visible to the
// main script exactly as it was when this code lived inline -- no build
// step, no module system, nothing else changes.
//
// Real dependency status, stated plainly: this file is NOT yet an
// independently runnable calculation library. It was split out of the main
// HTML file for organization (one file, one job), but it still relies on a
// handful of shared globals/functions defined in the main file's own inline
// <script> -- see the two documented gaps just below. Loading engine.js on
// its own, or in a test/Node context without those globals also defined,
// will fail at the call sites that use them. Closing that gap (so this file
// has no outside dependencies at all) is tracked as a possible future phase
// in ROADMAP.md, not something this split already did.
//
// What did NOT move: ~48 UI-only functions that were interleaved in the
// same section (event handlers, Monte Carlo/Reverse-Sequence panel toggles,
// the asset editor, plan import/export, DB-pension checkbox handling, etc.)
// stay in the main file, in their original relative order, since Phase 1
// already established they read the DOM directly and were never engine
// candidates.
//
// The actual list of things this file reaches into the main file's inline
// <script> for (corrected 2026-09-17 -- the earlier version of this header
// named only the first two; the 2026-09-16 review counted the rest):
//   Functions: _oasProjectionYear() (from _oasThresh/_getOAS/_getQPP/the
//     TFSA-limit and RRSP-limit indexers), _simEndAge() (the three simulate*
//     loops), _budgetTotalsAtAge()/_budgetItemMonthly()/
//     _budgetEscalationFactor() (the Budget-driven spending need and the
//     Emergency Fund line).
//   Globals read: liveData, currentAge, qppStart/oasStart, spendMode,
//     sustainSpendActive/Scale/Mode, TARGET_INCOME, RRIF_OVERRIDE/
//     TFSA_OVERRIDE, RATE_OVERRIDE, DB_BASE/DB_FROZEN, ASSETS,
//     BUDGET_SAVINGS/BUDGET_FREQ, _budgetIncomeData/_budgetBonusData, uiLang
//     (via i18n.js) -- all by shared global scope, no override guard.
//   computeEstate() moved INTO this file on 2026-09-17; the Budget-side
//   functions are the natural first target of the next split (a
//   budget-model.js loaded before this file -- see REVIEW_2026-09-16.md).
//   None of this breaks anything today (everything still reads the DOM /
//   globals correctly at call time -- see ROADMAP_COMPLETED.md's Phase 2
//   write-up for how the split was verified), but "load engine.js alone"
//   fails at every one of those sites, not just at two.
// ════════════════════════════════════════════════════════════════════════

// ── Simulation engine (browser port of _sim_v4.js) ────────────────────────────
// Tax bracket constants — 2026 tax year. Federal brackets/BPA are legislated
// (indexed automatically every Nov under ITA s.117.1); provincial brackets/BPA
// below (Quebec, Ontario, BC, Alberta — see PROVINCE_TAX_TABLES) are each
// province's own projected indexation and should be double-checked against
// the official published tables once each province confirms them (usually
// December). Whoever maintains this file: re-check all of this every January
// against taxtips.ca or a similar source.
// Every bracket/BPA/surtax/DTC figure in this block -- active AND dormant
// provinces alike -- is sourced from dated primary sources (CRA, Revenu
// Québec, and the BC government's own published rates, cross-checked
// against taxtips.ca/EY/KPMG tax-facts summaries) rather than trusted
// as-is; see tests/83-tax-constant-review.js for the sourced figures each
// check pins. The 4th federal bracket's rate is 29% (not 29.29%) for
// $181,440.01-$258,482, per CRA's own published 2026 rate table
// (canada.ca/en/revenue-agency/services/tax/individuals/
// tax-rates-brackets/current-year.html); the other four federal
// thresholds/rates and the BPA phase-out figures below match CRA exactly.
const FED_BRACKETS = [
  {upto:58523,    rate:0.14},
  {upto:117045,   rate:0.205},
  {upto:181440,   rate:0.26},
  {upto:258482,   rate:0.29},
  {upto:Infinity, rate:0.33},
];

const FED_BPA_MAX=16452, FED_BPA_MIN=14829;

// enhanced BPA phases out
const FED_BPA_PHASE_LO=181440, FED_BPA_PHASE_HI=258482;

// ...linearly across bracket 4
const QC_BRACKETS = [
  {upto:54345,    rate:0.14},
  {upto:108680,   rate:0.19},
  {upto:132245,   rate:0.24},
  {upto:Infinity, rate:0.2575},
];

const QC_BPA = 18952;

// Quebec's BPA isn't income-phased-out (unlike the federal one)

// Every supported province's brackets/BPA/eligible-dividend-tax-credit rate,
// plus two Quebec-only wrinkles that don't apply anywhere else: the 16.5%
// federal tax abatement (hasFederalAbatement), and Quebec having no surtax.
// Ontario is the mirror-image special case: no federal abatement, but its
// own two-tier surtax layered on top of basic Ontario tax (see `surtax`
// below and _provMarginalRate()/_calcTaxDetail()'s use of it). BC and
// Alberta have neither wrinkle — plain graduated brackets only. Adding a
// province beyond this initial short list means adding one more entry here
// (plus an <option> in the #profileProvince dropdown) — no other logic
// should need to change.
//
// The `bc` and `alberta` entries below are DORMANT, not deleted — the
// #profileProvince dropdown no longer offers them (this app focuses on
// Quebec, Ontario and Non-Resident), so _currentProvince() can never
// actually return 'bc'/'alberta' through normal use, but the data stays
// here, fully correct and still exercised by tests/20-province-tax-tables.js
// (via a temporarily-injected dropdown option, since that's now the only
// way to reach them) so it doesn't silently rot. Reactivating either one
// later is just restoring its <option> line — no data to rebuild.
const PROVINCE_TAX_TABLES = {
  quebec: {
    label: 'Quebec',
    abbr: 'QC',
    brackets: QC_BRACKETS,
    bpa: QC_BPA,
    // 11.70% of the GROSSED-UP (taxable) eligible dividend -- the base
    // _nonregTaxSplit() applies dtcRate to (grossedUp*pt.dtcRate), same as
    // every other province's entry. Revenu Québec's line-415 instructions
    // quote "16.1460%", but that figure is a percentage of the ACTUAL
    // dividend (TP-1 line 166), not the taxable amount: 0.117 × 1.38 =
    // 0.16146 exactly, which is the whole confusion. Until 2026-09-16 this
    // was 0.16146 applied to the grossed-up base, making the Quebec credit
    // 1.38× too generous (a $10,000 eligible dividend stacked on $150,000
    // paid $2,591 instead of $3,205). Cross-check that pins the correct
    // value: Quebec's published top combined marginal rate on eligible
    // dividends is 40.11%. Provincial: 1.38 × 25.75% − 16.146% (of actual)
    // = 19.39%; federal: (1.38 × 33% − 20.73%) × 0.835 abatement = 20.72%;
    // total 40.11% ✓. With 16.146% of the grossed-up amount the total would
    // be 33.97%, which matches nothing published. Sources: taxtips.ca Quebec
    // dividend tax credit table ("11.70% of grossed-up dividend = 16.146%
    // of actual dividend, 2020+"); Revenu Québec line 415.
    dtcRate: 0.117,            // QC's eligible-dividend tax credit, as a share of the grossed-up dividend (= 16.146% of the actual dividend)
    hasFederalAbatement: true, // the only province with this (16.5% off federal tax)
    surtax: null,
    // Ligne 361's age/retirement-income components -- see
    // _provAgeAndPensionAmount()'s header comment for the combined-reduction
    // formula this feeds and the sourcing/approximation caveat. 2026
    // figures: age amount max $3,986 (Quebec's 2026 budget "dépenses
    // fiscales" table, fiche 110111, finances.gouv.qc.ca, table C.8 -- also
    // the amount printed on the 2026 TP-1015.3 form); combined reduction
    // 18.75% of family net income over $42,955 (same sources);
    // retirement-income amount max $3,541 (2026 TP-1015.3 form, form itself
    // says: the lesser of eligible retirement income x 1.25, or this max).
    ageAmount: { max:3986, thresh:42955, reductionRate:0.1875 },
    pensionAmount: { max:3541 },
  },
  ontario: {
    label: 'Ontario',
    abbr: 'ON',
    brackets: [
      {upto:53891,    rate:0.0505},
      {upto:107785,   rate:0.0915},
      {upto:150000,   rate:0.1116},
      {upto:220000,   rate:0.1216},
      {upto:Infinity, rate:0.1316},
    ],
    bpa: 12989,
    dtcRate: 0.10,
    hasFederalAbatement: false,
    // Ontario's own surtax: 20% on basic Ontario tax over $5,818, plus a
    // further 36% on the portion over $7,446 (the two stack, giving a
    // combined 56% surtax multiplier above the higher threshold) — applied
    // to Ontario tax net of the BPA credit, before dividend tax credits.
    surtax: { tiers: [ {threshold:5818, rate:0.20}, {threshold:7446, rate:0.36} ] },
    // Ontario's own age amount (mirrors the federal shape -- 65+, reduced
    // by its own reductionRate of net income over thresh) and pension
    // income amount (no income test, capped at max). 2026 figures from the
    // 2026 TD1ON form (Ontario Personal Tax Credits Return): age amount max
    // $6,342, reduced to $0 between $47,210 and $89,490 net income --
    // 6342/(89490-47210) = exactly 0.15, so modeled as the same clean
    // 15%-of-excess formula the form's own worksheet produces; pension
    // income amount max $1,796 (Ontario's own figure -- unlike the federal
    // $2,000, this one IS indexed forward year to year, so it's run through
    // _idxFactor() below like every other Ontario dollar figure in this
    // table, not frozen).
    ageAmount: { max:6342, thresh:47210, reductionRate:0.15 },
    pensionAmount: { max:1796 },
  },
  bc: {
    label: 'British Columbia',
    abbr: 'BC',
    brackets: [
      {upto:50363,    rate:0.0560},
      {upto:100728,   rate:0.0770},
      {upto:115648,   rate:0.1050},
      {upto:140430,   rate:0.1229},
      {upto:190405,   rate:0.1470},
      {upto:265545,   rate:0.1680},
      {upto:Infinity, rate:0.2050},
    ],
    bpa: 13216,
    dtcRate: 0.12,
    hasFederalAbatement: false,
    surtax: null,
    // No ageAmount/pensionAmount here (or on alberta below) -- both
    // provinces are dormant (see this file's header comment on that), and
    // BC/Alberta's own 2026 age/pension-amount figures haven't been
    // researched, since this app's age/pension-credit modeling is scoped to
    // its currently-reachable provinces (Quebec, Ontario) plus Non-Resident.
    // _provAgeAndPensionAmount() already treats a missing ageAmount as $0
    // rather than crashing, so BC/Alberta simply have no age/pension credit
    // modeled until real figures are added here -- reactivating either
    // province still needs nothing but this one data addition, per this
    // file's own convention.
  },
  alberta: {
    label: 'Alberta',
    abbr: 'AB',
    brackets: [
      {upto:61200,    rate:0.08},
      {upto:154259,   rate:0.10},
      {upto:185111,   rate:0.12},
      {upto:246813,   rate:0.13},
      {upto:370220,   rate:0.14},
      {upto:Infinity, rate:0.15},
    ],
    bpa: 22769,
    dtcRate: 0.0812,
    hasFederalAbatement: false,
    surtax: null,
  },
};

// ── Inflation / forward-projection helpers ─────────────────────────────────
// #cpiRate is the user's inflation assumption, used verbatim to project
// target spending forward from today's dollars. Tax brackets, QPP/OAS
// benefit growth, and the OAS clawback threshold all use a more conservative
// rate instead — CPI minus a fixed haircut — on the theory that legislated
// indexation has, at times, lagged actual inflation (bracket freezes,
// rounding, methodology lag), so erring toward *higher* future tax/lower
// future benefits is the safer direction for a retirement plan to assume.
//
// The haircut's size reflects real 2015-2025 indexation-vs-CPI history for
// the federal government and all 4 provinces this app supports:
// federal/Ontario/BC all averaged essentially a ZERO gap over the decade
// (large swings from the ~14-month CPI-reference lag roughly cancel out
// over a full inflation cycle); Quebec ran a modest ~0.2pp behind on
// average; Alberta was the only real outlier, but from two discrete
// legislated FREEZES (2016, and 2020-2021) rather than a smooth
// year-over-year drift. 0.15pp is a real margin of safety against the kind
// of freeze that has genuinely happened, without assuming a persistent
// erosion the federal/Ontario/BC record doesn't actually show.
// A valid zero is an assumption, not a request for the default. Reject
// blank, malformed and non-finite values; retain supported negative rates.
// A single injectable override for every DOM-read "setting" the
// calculation engine below depends on -- personAge, currentProvince,
// cpiRate, and so on. Every one of the ~20 small getter functions in this
// engine section (this one included) checks this first and falls back to
// its normal document.getElementById read only when it's null. That means
// simulateResidentFixed() and everything it calls can be driven with
// explicit, known inputs -- from a plain Node script with no document at
// all, or from a browser test that wants one specific setting without
// touching a live form field -- while every existing call site throughout
// the rest of the app keeps working completely unchanged (they never set
// an override, so every getter takes its normal document-reading path
// exactly as before). Deliberately NOT a parameter threaded through the
// ~80 functions between a getter and its ultimate caller (simulate*,
// _calcTaxDetail, the rate formulas, etc.) -- that would touch far more
// call sites for the same practical outcome and is a higher-risk change.
// Set the whole object at once via
// _setEngineSettingsOverride()/_clearEngineSettingsOverride() rather than
// mutating individual fields, so a run always sees one complete, consistent
// snapshot rather than a mix of overridden and live-DOM values.
let _engineSettingsOverride = null;

function _setEngineSettingsOverride(settings){ _engineSettingsOverride = settings; }

function _clearEngineSettingsOverride(){ _engineSettingsOverride = null; }

// ── The engine's one door to the page (N16 / S2, 2026-09-20) ─────────────
// engine.js used to reach into the document 25 times, which meant the
// golden-snapshot tool needed a browser to run the engine at all and there
// was no way to exercise the engine in Node. It now reads every input
// through this port, and the app installs the real one at load
// (see _installEngineDom in the main file).
//
// Both accessors return undefined when there is no page -- exactly what
// `_domValue(id)` returned for a missing element, so
// every caller's existing default still applies and a Node context simply
// gets the defaults.
var _engineDom = null;
function _installEngineDom(port) { _engineDom = port; }
function _domValue(id)   { return _engineDom ? _engineDom.value(id)   : undefined; }
function _domChecked(id) { return _engineDom ? _engineDom.checked(id) : undefined; }

function _numberInputOrDefault(id, fallback){
  const raw = _domValue(id);
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function _cpiRate(){ if (_engineSettingsOverride) return _engineSettingsOverride.cpiRate; return _numberInputOrDefault('cpiRate', 2.5)/100; }

const CONSERVATIVE_HAIRCUT = 0.0015;

// Half of a capital gain is taxable income (Income Tax Act s.38(a)). Used
// wherever a gain is realised or deemed realised: an asset sold inside the
// horizon, a Non-Reg withdrawal in realistic-tax mode, the deemed
// disposition at death of Non-Reg and of a still-owned asset, the
// survivor's draw on an inherited Non-Reg account, and the final return.
const CAP_GAINS_INCLUSION_RATE = 0.5;

// Single source of randomness for Monte Carlo / the historical bootstrap.
// Defaults to Math.random; a test (or the snapshot harness) can swap in a
// seeded generator -- `_rng = mulberry32(42)` -- to make a Monte Carlo run
// reproducible, which was impossible while Math.random was called directly
// (2026-09-16 review, A12). Never reseeded by the app itself.
let _rng = Math.random;
function _seedRng(seed) {
  // mulberry32 -- small, fast, good enough for a deterministic test run.
  let a = (seed >>> 0) || 1;
  _rng = function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _unseedRng() { _rng = Math.random; }

// 0.15 percentage points below CPI
function _conservativeRate(){ return Math.max(0,_cpiRate()-CONSERVATIVE_HAIRCUT); }

function _personAge(){ if (_engineSettingsOverride) return _engineSettingsOverride.personAge; return parseInt(_domValue('accCurAge')) || 43; }

function _yearsOut(age){ return Math.max(0, age-_personAge()); }

function _idxFactor(age){ return Math.pow(1+_conservativeRate(), _yearsOut(age)); }

// tax-bracket/benefit indexation factor since today

function _bracketTax(income, brackets){
  let tax=0, prev=0;
  for (const b of brackets){
    if (income<=prev) break;
    tax += (Math.min(income,b.upto)-prev)*b.rate;
    prev = b.upto;
  }
  return tax;
}

// Same graduated-bracket math as _bracketTax() above, but broken OUT
// bracket-by-bracket instead of collapsed into one total -- used only by the
// "🧾 Tax Breakdown" tab's display, never by the simulation engine itself.
// Returns one row per bracket actually reached (every bracket up to and
// including whichever one `income` falls into; brackets entirely above
// income are omitted), each carrying its own range, rate, the slice of
// income actually taxed at that rate, and the resulting tax on just that
// slice. Summing every row's `.tax` reproduces _bracketTax()'s single total
// exactly (same arithmetic, same order) -- this is purely a presentation
// layer over the existing methodology, not a second implementation of it.
function _bracketBreakdown(income, brackets){
  const inc=Math.max(0,income);
  const rows=[]; let prev=0;
  for (const b of brackets){
    const amount=Math.max(0,Math.min(inc,b.upto)-prev);
    rows.push({from:prev, to:b.upto, rate:b.rate, amount, tax:amount*b.rate});
    if (inc<=b.upto) break;
    prev=b.upto;
  }
  return rows;
}

function _idxBrackets(brackets, age){
  const f=_idxFactor(age);
  if (f===1) return brackets;
  return brackets.map(b=>({upto: b.upto===Infinity?Infinity:Math.round(b.upto*f), rate:b.rate}));
}

function _fedMarginalRate(income, age){
  const inc=Math.max(0,income), fb=_idxBrackets(FED_BRACKETS,age);
  for (const b of fb) if (inc<=b.upto) return b.rate;
  return fb[fb.length-1].rate;
}

// Which province's tax rules apply — read from the Profile tab, defaulting
// to Quebec (today's only fully-modeled province) if unset or unrecognized.
function _currentProvince(){
  if (_engineSettingsOverride) return _engineSettingsOverride.currentProvince;
  const v = _domValue('profileProvince');
  return PROVINCE_TAX_TABLES[v] ? v : 'quebec';
}

// Quebec's government retirement pension is QPP (Quebec Pension Plan); every
// other province participates in CPP (Canada Pension Plan) instead. Same
// benefit concept, different name depending on which province governs it —
// unlike LIF maximums or tax brackets, there's no numeric difference to
// model here, just which label is correct to show.
function _cppQppLabel(){
  return _currentProvince()==='quebec' ? 'QPP' : 'CPP';
}

// Localized DISPLAY variant of _cppQppLabel() -- returns the standard Quebec
// French acronym (RRQ/RPC) when uiLang is 'fr', otherwise the plain English
// label unchanged. _cppQppLabel() itself stays English-only (nothing branches
// on its return value, but keeping it a stable internal identifier is safer
// than translating it in place) -- every user-facing call site added from
// French Translation Phase 2 onward calls THIS wrapper instead. See
// _updateEligibilityStatus()'s CQ_disp (Phase 1, Profile-tab status line
// only) for the original one-off version of this same mapping.
function _cppQppLabelDisp(){
  const cq = _cppQppLabel();
  return uiLang === 'fr' ? (cq === 'QPP' ? 'RRQ' : 'RPC') : cq;
}

// OAS requires 10 years of Canadian residency since age 18 for someone who
// currently lives in Canada, or 20 years for someone living outside Canada
// (canada.ca/en/services/benefits/publicpensions/old-age-security/eligibility.html)
// -- reuses the Profile tab's existing resident/expat toggle rather than
// asking a separate, redundant question.
function _oasYearsRequired(){
  if (_engineSettingsOverride) return _engineSettingsOverride.oasYearsRequired;
  return _domValue('profileResidency') === 'expat' ? 20 : 10;
}

// CPP/QPP eligibility: at least one valid contribution year, no residency
// requirement at all (retraitequebec.gouv.qc.ca and canada.ca/.../cpp/eligibility.html
// both confirm this — the benefit keeps paying wherever you later live).
function _qppEligible(){
  if (_engineSettingsOverride) return _engineSettingsOverride.qppEligible;
  return _domChecked('eligContributed') !== false;
}

// OAS eligibility: citizen or legal resident, AND enough years of Canadian
// residency since 18 for whichever of the two thresholds above applies.
function _oasEligible(){
  if (_engineSettingsOverride) return _engineSettingsOverride.oasEligible;
  const citizen = _domChecked('eligCitizen') !== false;
  return citizen && _oasQualifyingYears() >= _oasYearsRequired();
}

// User-entered complete years AT commencement, not a projection of future
// residence. Once payments begin, additional residence does not raise this
// fraction. This is a deliberate, explicit assumption.
function _oasQualifyingYears(){
  if (_engineSettingsOverride) return _engineSettingsOverride.oasQualifyingYears;
  const yrs = Number.parseFloat(_domValue('eligYearsInCanada'));
  return Number.isFinite(yrs) ? Math.max(0, Math.floor(yrs)) : 0;
}

function _provMarginalRate(income, age, provKey){
  const inc=Math.max(0,income), pt=PROVINCE_TAX_TABLES[provKey], pb=_idxBrackets(pt.brackets,age);
  let baseRate=pb[pb.length-1].rate;
  for (const b of pb) { if (inc<=b.upto){ baseRate=b.rate; break; } }
  if (!pt.surtax) return baseRate;
  const provBpaCredit=(pt.bpa*_idxFactor(age))*pb[0].rate;
  const provBase=Math.max(0,_bracketTax(inc,pb)-provBpaCredit);
  let multiplier=1;
  for (const tier of pt.surtax.tiers) {
    if (provBase > tier.threshold*_idxFactor(age)) multiplier += tier.rate;
  }
  return baseRate*multiplier;
}

function _fedBPA(income, age){
  // Enhanced federal BPA phases linearly from FED_BPA_MAX down to FED_BPA_MIN
  // across the 4th bracket's income range (ITA s.118(1.1)); all four amounts
  // scale forward with the same conservative indexation as the brackets.
  const f=_idxFactor(age);
  const lo=FED_BPA_PHASE_LO*f, hi=FED_BPA_PHASE_HI*f, max=FED_BPA_MAX*f, min=FED_BPA_MIN*f;
  if (income<=lo) return max;
  if (income>=hi) return min;
  return max-(max-min)*(income-lo)/(hi-lo);
}

// Real, eligibility-based federal + provincial age and pension income
// amounts, each with its own real dollar figures, its own income-testing
// (or lack of it), and its own credit rate -- computed below and applied
// directly to federal tax and provincial tax separately (age/pension
// credits only ever offset their OWN jurisdiction's tax, never a shared
// pool).
//
// What counts as "eligible pension income" (ITA s.118(7), and the
// provincial credits below borrow the same federal definition): a genuine
// lifetime RPP/DB pension qualifies at ANY age; RRIF/LIF payments only
// qualify once the recipient is 65+ (before 65 they qualify only on a
// spouse's death, not modeled in this single-retiree planner); CPP/QPP/
// OAS/GIS never qualify at any age.
function _eligiblePensionIncome(age, dbAmt, lifAmt, rrifAmt){
  return Math.max(0,dbAmt||0) + (age>=65 ? Math.max(0,lifAmt||0)+Math.max(0,rrifAmt||0) : 0);
}

// Federal age amount (line 30100, ITA s.118(2)) -- 65+, income-tested.
// 2026: max $9,208, reduced 15% of net income over $46,432, $0 at
// $107,819 (canada.ca .../line-30100-amount.html, checked 2026-09-14).
// Indexed forward like every other federal dollar figure in this file.
const FED_AGE_MAX=9208, FED_AGE_THRESH=46432;
// The federal age amount is reduced by 15 cents per dollar of net income
// over its threshold. Numerically the same as OAS_CLAWBACK_RATE and a
// different rule entirely, so it gets its own name: a change to one must
// never silently move the other.
const FED_AGE_CREDIT_REDUCTION = 0.15;

function _fedAgeAmount(income, age){
  if (age<65) return 0;
  const f=_idxFactor(age);
  return Math.max(0, FED_AGE_MAX*f - Math.max(0,income-FED_AGE_THRESH*f)*FED_AGE_CREDIT_REDUCTION);
}

// Federal pension income amount (line 31400, ITA s.118(3)) -- up to $2,000
// of eligible pension income, no income test. Frozen at $2,000 since 1988
// (CRA has never indexed it) -- unlike every other dollar figure in this
// file, deliberately NOT run through _idxFactor().
const FED_PENSION_MAX=2000;

function _fedPensionAmount(eligiblePensionIncome){
  return Math.min(FED_PENSION_MAX, Math.max(0,eligiblePensionIncome||0));
}

// Provincial age + pension-income amount, combined into one function since
// Quebec's real mechanics differ structurally from every other province's
// (see below) and both need the same inputs. Returns the province's own
// AMOUNT (not yet at its credit rate -- multiplied by provBrackets[0].rate
// by the caller, same as every other provincial credit in this file).
//
// Ontario (and BC/Alberta, once populated -- see PROVINCE_TAX_TABLES'
// comment on why they aren't yet) mirror the federal shape: a separate,
// independently income-tested age amount, plus an un-tested pension
// amount, each at that province's own dollar figures.
//
// Quebec's real ligne 361 instead combines the age amount and the
// "retirement income amount" into ONE base, reduced together by a single
// 18.75%-of-family-net-income-over-$42,955 formula (Revenu Québec's own
// age/retirement-income credit pages and the 2026 TP-1015.3 form, checked
// 2026-09-14) -- modeled here as: sum the two components' own maximums
// (retirement income capped at the lesser of its own max or 1.25x
// eligible pension income, per the TP-1015.3 form's own wording), then
// apply that one combined reduction. This app has no spouse/family-income
// field (a single-retiree model throughout), so "family net income" is
// approximated by the modeled person's own net income -- exact for
// someone genuinely filing alone, which is the only case this app ever
// represents. This is Claude's best reconstruction of Quebec's combined
// worksheet from public Revenu Québec documentation, not a verified
// line-by-line replica of its official Schedule/Annexe B -- the age-
// amount dollar figures and reduction rate themselves were independently
// confirmed against Quebec's 2026 budget "dépenses fiscales" table
// (finances.gouv.qc.ca, fiche 110111), but the combine-then-reduce-once
// mechanics are a reconstruction, flagged here and in the Help tab so
// this stays visible rather than silently presented as exact.
function _provAgeAndPensionAmount(income, age, eligiblePensionIncome, provKey){
  const pt=PROVINCE_TAX_TABLES[provKey];
  if (!pt.ageAmount) return 0; // BC/Alberta: not yet populated, see their own comment above
  const f=_idxFactor(age);
  if (provKey==='quebec') {
    const ageBase = age>=65 ? pt.ageAmount.max*f : 0;
    const retirementBase = Math.min(pt.pensionAmount.max*f, Math.max(0,eligiblePensionIncome||0)*1.25);
    const combined = ageBase+retirementBase;
    return Math.max(0, combined - Math.max(0,income-pt.ageAmount.thresh*f)*pt.ageAmount.reductionRate);
  }
  const ageAmt = age>=65 ? Math.max(0, pt.ageAmount.max*f - Math.max(0,income-pt.ageAmount.thresh*f)*pt.ageAmount.reductionRate) : 0;
  const pensionAmt = Math.min(pt.pensionAmount.max*f, Math.max(0,eligiblePensionIncome||0));
  return ageAmt+pensionAmt;
}

function _calcTax(income, age, eligiblePensionIncome=0, oasAmt=0) { return _calcTaxDetail(income, age, eligiblePensionIncome, oasAmt).total; }

// --- Provincial health levies (2026-09-17, review A7) --------------------
// Three amounts settled on the provincial return that the bracket math
// above does not capture. All three are "on" by default (Profile ->
// Assumptions -> "Include provincial health levies"); _healthLevies()
// returns {items:[{id, amt}], total} and _calcTaxDetail() folds the total
// into `prov`/`total` so every consumer (the year's row tax, the Tax
// Breakdown tab, the estate's final-return tax, the household pension-split
// optimiser) sees them. Resident mode only -- a non-resident files neither
// return. Marginal rates are NOT adjusted for the levy steps.
//   * Ontario Health Premium (ON428 step 7): the published step schedule on
//     TAXABLE income, unindexed since 2004 -- $0 under $20,000 rising in six
//     steps to $900 over $200,600 (ontario.ca/page/health-premium;
//     taxtips.ca/ontax/ontario-health-premium.htm).
//   * Quebec Health Services Fund contribution (TP-1 Schedule F, line 446):
//     1% of income subject to the contribution above $18,500, capped at
//     $150 until $64,355, then $150 + 1% of the excess over $64,355, capped
//     at $1,000 (2026 parameters, Finances Québec "Parameters of the
//     personal income tax system for 2026", table 3; indexed at the Quebec
//     rate each year -> _idxFactor). Income subject excludes employment
//     income, OAS benefits and the gross-up on dividends
//     (rcgt.com tax planning guide, HSF) -- here: taxable income minus OAS.
//   * Quebec prescription-drug-plan premium (TP-1 Schedule K, line 447 --
//     RAMQ public plan): $0 to a maximum per adult ($766 for July 2025-June
//     2026, $789 for July 2026-June 2027 -> $778 for the 2026 tax year,
//     ramq.gouv.qc.ca "Rates in effect"), phased in from a family-income
//     exemption (~$19,850 for a single adult in 2026, from the $18,910 2024
//     figure indexed) at the single-adult schedule's first rate (7.79%). Any
//     retiree above ~$30,000 pays the maximum, so the ramp only matters at
//     very low income. Applied from age 65 (under 65 the plan assumes
//     private-plan coverage through work; a person 65+ receiving 94%+ of the
//     maximum GIS is exempt -- not modelled, an income level this planner
//     is not aimed at). The per-adult maximum is charged per person, so the
//     household merge gets it once per spouse.
const ON_HEALTH_PREMIUM_STEPS = [ // [taxable income from, base, rate on excess, cap]
  [20000, 0, 0.06, 300], [36000, 300, 0.06, 450], [48000, 450, 0.25, 600], [72000, 600, 0.25, 750], [200000, 750, 0.25, 900],
];
const QC_HSF_2026 = { threshold1: 18500, cap1: 150, threshold2: 64355, max: 1000, rate: 0.01 };
const QC_RAMQ_2026 = { exemptionSingle: 19850, rate: 0.0779, max: 778, fromAge: 65 };
function _healthLeviesEnabled(){
  if (_engineSettingsOverride) return _engineSettingsOverride.healthLevies !== false;
  // No checkbox on the page (or no page at all) means the levies are on,
  // which is the default the Profile tab ships with.
  const v = _domChecked('healthLevies');
  return v == null ? true : !!v;
}
function _ontarioHealthPremium(taxable){
  let prem = 0;
  for (const [from, base, rate, cap] of ON_HEALTH_PREMIUM_STEPS) {
    if (taxable > from) prem = Math.min(cap, base + (taxable - from) * rate);
  }
  return Math.round(prem);
}
function _quebecHsf(incomeSubject, age){
  const f = _idxFactor(age), t1 = QC_HSF_2026.threshold1 * f, t2 = QC_HSF_2026.threshold2 * f;
  const inc = Math.max(0, incomeSubject);
  if (inc <= t1) return 0;
  if (inc <= t2) return Math.round(Math.min(QC_HSF_2026.cap1, (inc - t1) * QC_HSF_2026.rate));
  return Math.round(Math.min(QC_HSF_2026.max, QC_HSF_2026.cap1 + (inc - t2) * QC_HSF_2026.rate));
}
function _quebecRamqPremium(netIncome, age){
  if (age < QC_RAMQ_2026.fromAge) return 0;
  const f = _idxFactor(age);
  return Math.round(Math.max(0, Math.min(QC_RAMQ_2026.max * f, (netIncome - QC_RAMQ_2026.exemptionSingle * f) * QC_RAMQ_2026.rate)));
}
// `employmentIncome` (2026-09-17 second review, M3): the Quebec HSF is a
// contribution on NON-employment income only (the employer pays the payroll
// side), so the Budget tab's salary tax passes the salary here to keep it
// out of the HSF base. Ontario's premium does apply to salary.
function _healthLevies(income, age, oasAmt=0, employmentIncome=0){
  const items = [];
  if (_healthLeviesEnabled()) {
    const prov = _currentProvince();
    const inc = Math.max(0, income);
    if (prov === 'ontario') {
      const ohp = _ontarioHealthPremium(inc); if (ohp > 0) items.push({ id: 'ohp', amt: ohp });
    } else if (prov === 'quebec') {
      const hsf = _quebecHsf(inc - Math.max(0, oasAmt||0) - Math.max(0, employmentIncome||0), age); if (hsf > 0) items.push({ id: 'hsf', amt: hsf });
      const ramq = _quebecRamqPremium(inc, age); if (ramq > 0) items.push({ id: 'ramq', amt: ramq });
    }
  }
  return { items, total: items.reduce((s, i) => s + i.amt, 0) };
}

function _calcTaxNonResident(income, age, eligiblePensionIncome=0) { return _calcTaxDetailNonResident(income, age, eligiblePensionIncome).total; }

function _calcTaxDetail(income, age=_personAge(), eligiblePensionIncome=0, oasAmt=0, employmentIncome=0){
  // Returns {fed, prov, total, marginal, effective} for a resident of
  // whichever province is currently selected on the Profile tab (defaults
  // to Quebec). Full graduated brackets applied to income (all federal/
  // provincial tiers — previously this stopped at the federal 26% tier and
  // silently taxed everything above ~$115K at 26%, understating tax in
  // high-income years). BPA is credited at each jurisdiction's lowest rate
  // rather than pre-subtracted from income, which is the technically correct
  // CRA method and matters once income reaches a higher bracket. Brackets/
  // BPA/credits are all indexed forward from today to `age` at the
  // conservative rate.
  //
  // The age amount and pension income amount (see _fedAgeAmount()/
  // _fedPensionAmount()/_provAgeAndPensionAmount()'s own header comments)
  // are applied DIRECTLY to each jurisdiction's own tax (folded into
  // fedRaw/provBase right alongside BPA, before Ontario's surtax and the QC
  // abatement -- both of which apply to tax already net of these credits)
  // rather than pooled into one figure and split proportionally by each
  // side's share of gross tax. Real non-refundable credits only ever offset
  // their OWN jurisdiction's tax -- a federal-only retiree with no
  // provincial tax owing doesn't get a "provincial share" of unused federal
  // credit back. fedRaw/provBase are each independently floored at $0 (real
  // non-refundable credits can't go negative or carry over between
  // jurisdictions).
  const provKey=_currentProvince(), pt=PROVINCE_TAX_TABLES[provKey];
  const inc=Math.max(0,income);
  const fedGross=_bracketTax(inc,_idxBrackets(FED_BRACKETS,age));
  const fedBpaCredit=_fedBPA(inc,age)*FED_BRACKETS[0].rate;
  const fedAgeAndPensionCredit=(_fedAgeAmount(inc,age)+_fedPensionAmount(eligiblePensionIncome))*FED_BRACKETS[0].rate;
  const fedRaw=Math.max(0,fedGross-fedBpaCredit-fedAgeAndPensionCredit)*(pt.hasFederalAbatement?0.835:1); // QC-only federal abatement (16.5%)
  const provBrackets=_idxBrackets(pt.brackets,age);
  const provGross=_bracketTax(inc,provBrackets);
  const provBpaCredit=(pt.bpa*_idxFactor(age))*provBrackets[0].rate;
  const provAgeAndPensionCredit=_provAgeAndPensionAmount(inc,age,eligiblePensionIncome,provKey)*provBrackets[0].rate;
  const provBase=Math.max(0,provGross-provBpaCredit-provAgeAndPensionCredit);
  // Ontario-only: a two-tier surtax on top of basic provincial tax (net of
  // BPA and the age/pension credit, before dividend tax credits — see
  // PROVINCE_TAX_TABLES' comment). `surtax:null` for every other province
  // makes this a no-op there.
  let provSurtax=0;
  if (pt.surtax) {
    for (const tier of pt.surtax.tiers) {
      provSurtax += Math.max(0, provBase - tier.threshold*_idxFactor(age)) * tier.rate;
    }
  }
  // Provincial health levies (2026-09-17, A7) -- see _healthLevies() above.
  const levies=_healthLevies(inc, age, oasAmt, employmentIncome);
  const prov=provBase+provSurtax+levies.total;
  const fedNet=Math.round(fedRaw);
  const provNet=Math.round(prov);
  // otherCreditsFed/otherCreditsProv keep their pre-existing field names
  // (the Tax Breakdown tab's "Less BPA & other credits" line reads them)
  // but are now each jurisdiction's own real, directly-computed age+pension
  // credit rather than a proportional split of one pooled guess.
  const otherCreditsFed=Math.round(fedAgeAndPensionCredit);
  const otherCreditsProv=Math.round(provAgeAndPensionCredit);
  return {fed:fedNet,prov:provNet,total:fedNet+provNet,
    marginal:_fedMarginalRate(inc,age)*(pt.hasFederalAbatement?0.835:1)+_provMarginalRate(inc,age,provKey),
    effective:income>0?(fedNet+provNet)/income:0,
    otherCreditsFed,otherCreditsProv,
    healthLevy:levies.total,healthLevyItems:levies.items,provBeforeLevies:Math.round(provBase+provSurtax)};
}

// Non-resident Part XIII withholding rates, editable on the Profile tab
// (only shown once residency there is set to "Non-Resident"). Each defaults
// to Canada's plain statutory rate when its field is left blank — so an
// untouched planner reproduces the exact numbers this file always used,
// since 25% happens to already be correct for the Philippines treaty. Read
// straight from the DOM on every call, same pattern as _cpiRate() — no
// separate cached variable to keep in sync.
function _nrPensionRate(){ if (_engineSettingsOverride) return _engineSettingsOverride.nrPensionRate; const v=_domValue('nrPensionRate'); return (v===''||v==null||isNaN(parseFloat(v)))?0.25:parseFloat(v)/100; }

function _nrDividendRate(){ if (_engineSettingsOverride) return _engineSettingsOverride.nrDividendRate; const v=_domValue('nrDividendRate'); return (v===''||v==null||isNaN(parseFloat(v)))?0.25:parseFloat(v)/100; }

function _nrInterestRate(){ if (_engineSettingsOverride) return _engineSettingsOverride.nrInterestRate; const v=_domValue('nrInterestRate'); return (v===''||v==null||isNaN(parseFloat(v)))?0.25:parseFloat(v)/100; }

// Part XIII default rate for a LUMP-SUM RRSP/RRIF/LIF payment to a
// non-resident. Treaties that reduce the rate on PERIODIC pension payments
// (e.g. to 15%) almost always leave lump sums at the statutory 25%, so the
// editable "pension" withholding rate must not be applied to the year-3
// LIF commutation in simulateNonResidentLump -- until 2026-09-17 it was
// (2026-09-16 review, A12). `lumpSumIncome` is the part of `income` that
// is such a lump; 0 everywhere except that one year.
const NR_LUMP_SUM_RATE = 0.25;

function _calcTaxDetailNonResident(income, age=_personAge(), eligiblePensionIncome=0, lumpSumIncome=0){
  // Returns {fed, prov, total, marginal, effective, method} for a non-resident.
  // Each tax year, a non-resident can independently choose whether to file the
  // S.217 election for that year's eligible pension/RRIF/LIF income:
  //  - Elect S.217: full graduated federal brackets + BPA credit (same as a
  //    resident) to arrive at "tax payable under Part I", then the ITA
  //    s.120(1) 48% federal surtax applies to that net amount "in lieu of"
  //    provincial tax. (Previously this also stopped at the 26% federal
  //    tier — same fix as the resident case above.)
  //  - Don't elect: flat Part XIII withholding on the GROSS amount instead —
  //    final tax, no deductions/credits, at the rate from the Profile tab's
  //    "Pension / RRIF / LIF" field (see _nrPensionRate() above), which
  //    defaults to Canada's 25% statutory rate when left blank. (For the
  //    Philippines specifically, that treaty's pension article caps periodic
  //    payments over $5,000/yr at 30% — worse than the 25% default — so the
  //    treaty never actually reduces the rate below it.)
  // The election is all-or-nothing per year, so we model the taxpayer picking
  // whichever of the two produces less tax for that year's total income.
  const inc=Math.max(0,income);
  // Same approach as _calcTaxDetail's own -- the real federal age amount +
  // pension income amount (there's no provincial component to a
  // non-resident's tax, so only the federal credit applies here; see
  // _fedAgeAmount()/_fedPensionAmount()'s header comments).
  const otherCredits=(_fedAgeAmount(inc,age)+_fedPensionAmount(eligiblePensionIncome))*FED_BRACKETS[0].rate;
  const fedGross=_bracketTax(inc,_idxBrackets(FED_BRACKETS,age));
  const fedBpaCredit=_fedBPA(inc,age)*FED_BRACKETS[0].rate;
  const netBasicFed=Math.max(0,fedGross-fedBpaCredit-otherCredits);
  const electedTotal=Math.round(netBasicFed*1.48); // s.120(1): 48% surtax in lieu of provincial tax
  const pensionRate=_nrPensionRate();
  const lump=Math.max(0,Math.min(inc,lumpSumIncome||0));
  const flatTotal=Math.round((inc-lump)*pensionRate + lump*NR_LUMP_SUM_RATE);
  const useFlat=flatTotal<electedTotal;
  const total=useFlat?flatTotal:electedTotal;
  const marginal=useFlat?pensionRate:_fedMarginalRate(inc,age)*1.48;
  return {fed:Math.round(total),prov:0,total:Math.round(total),marginal,effective:income>0?total/income:0,
    method:useFlat?'flat25':'s217',electedTax:electedTotal,flatTax:flatTotal,healthLevy:0,healthLevyItems:[]}; // no provincial levies for a non-resident (field present so consumers never read undefined)
}

// The Year-by-Year table has no collapsible tax-detail row -- every column
// instead has its own per-cell mouseover box; see _showAcctHover()'s
// 'target'/'budget'/'taxable'/'tax'/'wr'/'nonregBal'/'emergBal' branches
// (post-retirement) and _showAcctHoverPre()'s
// 'budget'/'taxable'/'tax'/'nrBal' branches (pre-retirement) below.
// Threshold is keyed to the INCOME year, not a fixed person's age.
// https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/recovery-tax.html
const OAS_RECOVERY_BASE_YEAR = 2026;

const OAS_RECOVERY_BASE_THRESHOLD = 95323;

// The OAS recovery tax takes 15 cents of every dollar of net income above
// the threshold, capped at the OAS actually received. One rate, applied in
// six places -- each simulate* loop, the gap-fill's own look-ahead, the
// household's per-person tax and the estate's final return -- which is
// exactly why it is named rather than repeated (N15 / S6).
const OAS_CLAWBACK_RATE = 0.15;

function _oasThresh(age){
  const years = Math.max(0, _oasProjectionYear(age) - OAS_RECOVERY_BASE_YEAR);
  return Math.round(OAS_RECOVERY_BASE_THRESHOLD * Math.pow(1 + _conservativeRate(), years));
}

function _dbCola(){ if (_engineSettingsOverride) return _engineSettingsOverride.dbCola; return _numberInputOrDefault('dbCola', 1)/100; }

function _dbFreeze(){ if (_engineSettingsOverride) return _engineSettingsOverride.dbFreeze; return parseInt(_domValue('dbFreezeAge'))||75; }

// Bridge benefit: an extra amount some DB plans pay from retirement until a
// set age (typically 65, when CPP/QPP/OAS start), then it stops -- separate
// from the per-age DB_BASE table above rather than folded into it, per JP's
// explicit choice, so the base pension amounts never need re-entering just
// because a bridge is added, changed, or removed. Blank means "no bridge"
// (amount defaults to 0) / "ends at 65" (matching the default bridge-to-CPP
// design), same blank-means-default convention as _nrPensionRate() etc.
// elsewhere in this file -- an explicit "0" amount is a real $0 bridge, not
// "unset".
function _dbBridgeAmount(){ if (_engineSettingsOverride) return _engineSettingsOverride.dbBridgeAmount; const v=_domValue('dbBridgeAmount'); return (v===''||v==null)?0:(parseFloat(v)||0); }

function _dbBridgeEndAge(){ if (_engineSettingsOverride) return _engineSettingsOverride.dbBridgeEndAge; const v=parseInt(_domValue('dbBridgeEndAge')); return Number.isFinite(v)&&v>0?v:65; }

// Retirement age is no longer limited to the 7 checkpoint ages DB_BASE/
// DB_FROZEN are keyed by (55, 60-65) -- the age-select input now accepts
// any age. For an off-checkpoint `ra`, DB pension amounts carry forward
// from the nearest LOWER checkpoint, the same "blank field carries
// forward" convention _updateDBTables() already applies across those 7
// ages, just generalized. Below age 55 there's no lower checkpoint to
// carry from, so this returns null and callers treat DB as $0 there.
const DB_CHECKPOINTS=[55,60,61,62,63,64,65];

function _dbCheckpointFor(ra){
  let best=null;
  for(const a of DB_CHECKPOINTS){ if(a<=ra && (best===null||a>best)) best=a; }
  return best;
}

function _getDB(ra,age){
  if (!useDBPension) return 0;
  // N17 (F3): the entitlement is the one earned by retiring when this
  // person actually retired. Before N17 a plan rolled from 62 to 66 was
  // quietly paid the age-66 entitlement -- a bigger pension than the
  // retiree ever qualified for -- unless the optional "DB actually
  // received" field on the checkpoint happened to have been filled in.
  const dbCp=_dbCheckpointFor(_retirementAge(ra));
  const base=dbCp!=null?(DB_BASE[dbCp]||0):0;
  const cola=_dbCola(), freeze=_dbFreeze();
  const frozen=dbCp!=null?(DB_FROZEN[dbCp]||Math.round(base*Math.pow(1+cola,freeze-64))):0;
  let amt;
  if(age<65) amt=base;
  else if(age>=freeze) amt=frozen;
  else amt=Math.round(base*Math.pow(1+cola,age-64));
  // Bridge benefit layers on top of whichever of the above applies, for as
  // long as the simulated age is still below the configured bridge-end age,
  // then drops off entirely from that age onward -- independent of the COLA/
  // freeze schedule above, which keeps running on the base amount regardless.
  if(age<_dbBridgeEndAge()) amt+=_dbBridgeAmount();
  return amt;
}

// RRIF minimum-withdrawal factors, Income Tax Regulations s.7308(4), as
// amended for 2015+ (the "prescribed factors" table CRA publishes in
// "Minimum amount from a RRIF"). Under 71 the factor is the formula
// 1/(90 − age); from 71 on it's this table; 95 and over is a flat 20%.
// A LIF's minimum is the same RRIF minimum (the LIF MAXIMUM is the
// separate provincial/federal cap in _lifMaxRate/FED_LIF_MAX below).
// Until 2026-09-16 both functions interpolated straight lines between only
// nine anchor ages (65/70/71/72/75/80/85/90/95) -- off by up to 0.66 pp at
// the un-anchored ages (e.g. 92: 15.15% vs 14.49%; 87: 9.87% vs 9.55%; 66:
// 4.20% vs 4.17%), forcing ~$1,900/yr of extra taxable income on a $600k
// RRIF at 87 -- and _lifMinRate returned 19.79% at 95+ instead of 20%.
// Found by the 2026-09-16 review.
const RRIF_MIN_FACTORS_71_PLUS = {
  71:.0528, 72:.0540, 73:.0553, 74:.0567, 75:.0582, 76:.0598, 77:.0617, 78:.0636, 79:.0658,
  80:.0682, 81:.0708, 82:.0738, 83:.0771, 84:.0808, 85:.0851, 86:.0899, 87:.0955, 88:.1021,
  89:.1099, 90:.1192, 91:.1306, 92:.1449, 93:.1634, 94:.1879,
};

function _rrifMinRate(age){
  if(age>=95) return .20;
  if(age<71) return 1/(90-age);
  return RRIF_MIN_FACTORS_71_PLUS[Math.floor(age)];
}

function _lifMinRate(age){
  return _rrifMinRate(age);
}

// Federal LIF maximum withdrawal % (Pension Benefits Standards Regulations, 1985 — OSFI).
// This is a HARD CAP unique to LIFs (RRIFs have no maximum). Based on the Nov-2025
// Bank of Canada Series V122487 10yr+ bond yield (3.49%), used for the 2026 OSFI table.
// This table now applies ONLY when the DC Pension box's "Federally regulated
// pension" checkbox is checked (see #dcFederallyRegulated) — otherwise
// _lifMaxRate() below uses the selected province's own rule instead, since a
// LIF's real maximum is governed by whichever pension legislation created it,
// not by the federal rules by default.
const FED_LIF_MAX={55:5.2096,56:5.2637,57:5.3224,58:5.3861,59:5.4552,60:5.5304,61:5.6125,62:5.7022,
  63:5.8005,64:5.9084,65:6.0272,66:6.1586,67:6.3042,68:6.4662,69:6.6474,70:6.8508,71:7.0804,72:7.3413,
  73:7.6397,74:7.9836,75:8.3837,76:8.8423,77:9.3729,78:9.9935,79:10.7287,80:11.6128,81:12.6955,
  82:14.0512,83:15.7970,84:18.1280,85:21.3952,86:26.3008,87:34.4831,88:50.8575,89:100};

// Ontario/BC/Alberta's LIF maximum: each regulator's own published
// methodology describes the same structure — balance ÷ F, where F is the
// present value of a $1/year annuity-due paid from the current age through
// age 89 (the LIF must pay out in full at 90), discounted at whichever is
// higher: the current long-term Government of Canada bond yield, or a 6%
// floor unique to these provinces (the federal table above has no such
// floor). Computed live from that formula rather than copied from a
// secondary table: several third-party sources were checked while building
// this (2026-09) and disagreed with each other on the exact published
// numbers, so recomputing from the regulator-confirmed formula avoids
// baking in a wrong or stale copied figure. CURRENT_LONG_BOND_RATE should
// track the same rate FED_LIF_MAX's own comment cites — re-check both
// together each January. Real yields have stayed well below 6% for years,
// so the 6% floor is what's actually binding today; if that ever changes,
// this formula already accounts for it (unlike a hardcoded table would).
const CURRENT_LONG_BOND_RATE = 0.0349;

const PROV_LIF_FLOOR_RATE = 0.06;

function _provLifMaxRate(age){
  const a=Math.max(55,Math.min(Math.round(age),90));
  if (a>=90) return 1.0;
  const n=90-a;
  const r=Math.max(CURRENT_LONG_BOND_RATE,PROV_LIF_FLOOR_RATE);
  const v=1/(1+r);
  const F=(1-Math.pow(v,n))/(1-v); // annuity-due: sum of v^0..v^(n-1)
  return 1/F;
}

// Small-balance full-unlock provisions: when a locked-in account's balance is
// small enough, several jurisdictions let the whole thing be unlocked and
// withdrawn — not just that year's LIF-max percentage. Per JP's framing when
// this was scoped: an eligibility FACT driven by balance (and, for Ontario,
// age), not an elective choice. Modeled exactly like Quebec's already-uncapped
// LIF above: when eligible, the LIF-max rate simply becomes 100% for that
// year, so the existing gap-fill logic can draw as much as the spending
// target actually needs — this doesn't force a full withdrawal, it just lifts
// the ceiling. Researched directly against each regulator (2026):
//  - Alberta (ATB Financial's published guide) and British Columbia (BCFSA,
//    confirmed directly): no minimum age at all. Under 20% of YMPE below age
//    65, under 40% of YMPE at 65+.
//  - Ontario (FSRA, "Pension Unlocking: Non-Hardship", Form 5): a single 40%-
//    of-YMPE threshold, but ONLY at age 55+ — no lower-age tier exists.
//    (Ontario proposed removing the age-55 requirement for LIRAs, and
//    expanding LIF/locked-in RRIF unlocking further, in an August 2026
//    consultation — still a draft, not in force, so not modeled here; revisit
//    if/when that regulation actually lands.)
//  - Federal (OSFI, for the "Federally regulated pension" override checkbox):
//    full unlock at or under 50% of YMPE, age 55 or older (OSFI's
//    unlocking-options page: "55 years old within the calendar year").
//  - Quebec: moot — its LIF already has no cap at all (see below), so a
//    small-balance rule would never change anything here.
// YMPE (Year's Maximum Pensionable Earnings, CPP/QPP) for 2026 is $74,600 —
// re-check every January alongside the other year-pinned figures in this file.
const YMPE_2026 = 74600;

// `jurisdiction` is a plain string parameter here, not read from
// _currentProvince() — so the 'alberta'/'bc' branch below stays reachable
// and testable (tests/28-small-balance-lif-unlock.js calls it directly)
// even though neither is a selectable #profileProvince option today.
// Dormant via the dropdown, not dead in the code.
function _smallBalanceUnlockAllowed(jurisdiction, age, lifBal) {
  if (!(lifBal > 0)) return false;
  if (jurisdiction === 'federal') return age >= 55 && lifBal <= YMPE_2026 * 0.5; // OSFI: 55 or older in the calendar year AND at most 50% of the YMPE (the age gate was missing until 2026-09-17)
  if (jurisdiction === 'ontario') return age >= 55 && lifBal < YMPE_2026 * 0.4;
  if (jurisdiction === 'alberta' || jurisdiction === 'bc') {
    return lifBal < (age >= 65 ? YMPE_2026 * 0.4 : YMPE_2026 * 0.2);
  }
  return false; // quebec: already uncapped, see _lifMaxRate below
}

// Centralizes the three separate inline
// _domChecked('dcFederallyRegulated') reads (this
// function, _halfUnlockAllowed, _halfUnlockUnavailableReason) into one
// named getter, so it can respect the same engine-settings override the
// other getters above do. Purely a naming/dedup change -- behavior when
// NOT overridden is identical to the three inline reads it replaces.
function _federallyRegulated(){
  if (_engineSettingsOverride) return _engineSettingsOverride.federallyRegulated;
  return !!_domChecked('dcFederallyRegulated');
}

function _lifMaxRate(age, lifBal){
  if (_federallyRegulated()) {
    if (_smallBalanceUnlockAllowed('federal', age, lifBal)) return 1.0;
    const a=Math.max(55,Math.min(Math.round(age),89));
    return (FED_LIF_MAX[a]||100)/100;
  }
  const provKey=_currentProvince();
  if (provKey==='quebec') {
    // Quebec eliminated the LIF maximum for ages 55+ effective Jan 1, 2025
    // (Retraite Québec / Revenu Québec reform) — once you're 55, there is no
    // regulatory ceiling on annual LIF withdrawals. This app never simulates
    // LIF withdrawals below 55, so no separate under-55 Quebec formula is
    // needed here.
    return 1.0;
  }
  if (_smallBalanceUnlockAllowed(provKey, age, lifBal)) return 1.0;
  // Ontario, BC, Alberta all share this formula per their regulators'
  // published methodology (FSRA/BCFSA/Alberta Treasury Board — see comment
  // on _provLifMaxRate above). provKey can only actually be 'bc'/'alberta'
  // here via a test injecting a dropdown option that no longer ships in the
  // app (see PROVINCE_TAX_TABLES' comment on dormant provinces) — this branch is left
  // untouched so that reactivating either province needs no changes here.
  return _provLifMaxRate(age);
}

// Reads the Accumulation tab's "CPP/QPP Amount at 65" input, defaulting to
// the same $19,718 the app always used when that field didn't yet exist.
// (The field also carries a "18000" placeholder, shown only when it's been
// deliberately left blank -- e.g. right after Clear All Data -- as a
// generic example rather than JP's own real figure; this internal fallback
// intentionally still matches the field's own real HTML default so normal
// usage and the test suite see zero behavior change.)
function _qppBase65(){
  if (_engineSettingsOverride) return _engineSettingsOverride.qppBase65;
  const v=parseFloat(_domValue('qppBase65'));
  return isNaN(v)?19718:v;
}

// Real statutory deferral ranges (Retraite Québec / canada.ca): OAS defers
// continuously from 65 up to 70 at +0.6%/month (max +36%) everywhere in
// Canada. CPP (every province except Quebec) defers the same 65-70 range
// as OAS, at +0.7%/month, maxing out at 70 (+42%) — canada.ca is explicit
// that "there's no benefit to wait after age 70". QPP (Quebec only) is the
// one exception: Quebec's own legislation lets it keep deferring all the
// way to 72 (+58.8%), a full two years past CPP's ceiling — confirmed via
// Retraite Québec's own page. Used both for the start-age sliders' min/max
// and for the precomputed combo grid in runLiveSim() — see _qppMaxStart().
const QPP_MIN_START=65;

const OAS_MIN_START=65, OAS_MAX_START=70;

// 72 for Quebec's QPP, 70 for CPP everywhere else — see the constants'
// comment above. Mirrors _cppQppLabel()'s own province check, since it's
// the same underlying QPP-vs-CPP distinction.
function _qppMaxStart(){
  return _currentProvince()==='quebec' ? 72 : 70;
}

// "% of maximum" sanity-check line shown next to the QPP/CPP Amount at 65
// input (JP, roadmap item 3 of the CPP/QPP batch): the government-published
// maximum retirement pension for someone starting at exactly age 65, so JP
// can see at a glance how his own entered amount compares. Point-in-time
// 2026 figures (both programs re-index annually, roughly each January) --
// this is a rough "near the max" / "well under max" gauge, not a projection.
// CPP: canada.ca "Canada Pension Plan: Pensions and benefits monthly
// amounts" -- $1,507.65/mo max for a new recipient starting at 65 in 2026.
// QPP: Retraite Québec's own "Calculation of your retirement pension" table
// -- $1,508/mo max for someone entitled to the maximum pension starting at
// 65 in 2026 (the two programs' maximums are close but not identical, since
// QPP's additional-plan enhancement phased in on a slightly different
// schedule than CPP's).
const CPP_MAX_MONTHLY_AT_65_2026 = 1507.65;

const QPP_MAX_MONTHLY_AT_65_2026 = 1508;

function _qppMaxAt65Annual(){
  return (_currentProvince()==='quebec' ? QPP_MAX_MONTHLY_AT_65_2026 : CPP_MAX_MONTHLY_AT_65_2026) * 12;
}

// The "Amount at 65" input is a TODAY'S-DOLLAR (2026) figure -- it is what
// the Accumulation tab compares to the 2026 published maximum just above
// ("≈ N% of the QPP maximum at 65 … 2026 figures"), and it is the number a
// Retraite Québec / Service Canada statement of contributions quotes: the
// pension you'd get at 65 in today's dollars, before the plan's own annual
// CPI indexation. Both CPP and QPP index the pension every January, from
// today until it starts AND after it starts, so the amount is grown at the
// same CPI-minus-haircut rate as OAS, from this reference year to the
// PAYMENT year -- exactly _getOAS()'s convention below (index from the
// dated base year to _oasProjectionYear(age), deferral as a separate,
// additive bonus). Until 2026-09-16 the base was treated as the NOMINAL
// amount at the start age and only indexed after it started, which (a)
// understated guaranteed income for anyone not already 65 -- for a
// 43-year-old at 2.5% CPI, OAS was grown ×1.67 to age 65 while QPP was not
// -- and (b) understated the value of deferring: QPP at 70 came out at
// 1.264× the 65-then-indexed-to-70 amount instead of the statutory 1.42×,
// biasing every start-age comparison and the sustainable-spend search
// toward starting early. Found by the 2026-09-16 review.
const QPP_BASE_YEAR = 2026;

function _getQPP(age,qppStart){
  if (!_qppEligible()) return 0;
  if (age < qppStart) return 0;
  // Deferral: the real statutory factor (+0.7%/month, i.e. +8.4%/year)
  // rather than a second hardcoded constant for age 70 -- same live-formula
  // approach as _getOAS(). Continuous, so any qppStart 65-72 works.
  const QPP_DEFER_RATE_MONTHLY=0.007;
  const monthsDeferred=Math.max(0,qppStart-65)*12;
  const deferral = 1 + QPP_DEFER_RATE_MONTHLY*monthsDeferred;
  // Index from the reference year to the payment year exactly once (both
  // before and after the start age, since CPP/QPP index throughout).
  const years = Math.max(0, _oasProjectionYear(age) - QPP_BASE_YEAR);
  const index = Math.pow(1+_conservativeRate(), years);
  return Math.round(_qppBase65() * deferral * index);
}

// Published July–September 2026 monthly maximum, ages 65–74. Annualized
// run rate, NOT the sum of the four actual quarterly rates for 2026.
// https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/payments.html
// https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/when-start.html
const OAS_BASE_YEAR = 2026;

const OAS_BASE_MONTHLY = 751.97;

const OAS_DEFER_RATE_MONTHLY = 0.006;

function _getOAS(age,oasStart){
  if (!Number.isFinite(age) || !Number.isFinite(oasStart) || !_oasEligible()) return 0;
  const start = Math.max(65, oasStart);
  if (age < start) return 0;
  // Index from the dated reference year to the PAYMENT year exactly once;
  // deferral is an additive age bonus, not a second inflation period.
  // Pre-2026 rows use the reference run rate (historical rates not modeled).
  const years = Math.max(0, _oasProjectionYear(age) - OAS_BASE_YEAR);
  const index = Math.pow(1 + _conservativeRate(), years);
  const residence = Math.min(40, _oasQualifyingYears()) / 40;
  const monthsDeferred = Math.min(60, Math.max(0, start - 65) * 12);
  const deferral = 1 + OAS_DEFER_RATE_MONTHLY * monthsDeferred;
  // Annual age-band convention: full 10% increase from the age-75 row.
  // Actual payments increase the month after the birthday; no monthly
  // commencement/birthday proration in this annual planner.
  return Math.round(OAS_BASE_MONTHLY * 12 * index * residence * deferral * (age >= 75 ? 1.10 : 1));
}

// Manual, editable target spending by INDIVIDUAL AGE (today's $), covering
// the fixed range 55-110 regardless of retirement age or the "predict until
// age X" horizon -- one single source of truth, so switching between
// retirement-age scenarios or lengthening/shortening the simulation horizon
// never loses or re-asks for a year's value. Click a year's Target cell in
// the Year-by-Year Withdrawal Breakdown table to edit it (see
// _openTargetEditor() et al. below); "Copy until age" there bulk-fills the
// same value forward through a chosen end age.
//
// The previous system of 5 fixed, always-visible age-band inputs (tgt60
// [60-64], tgt65 [65-69], tgt70 [70-74], tgt75 [75-79], tgt80 [80+]) was
// replaced by this per-year click-to-edit table with "copy until age".
// _defaultTargetForAge() reproduces those bands' exact boundaries and
// fallback amounts -- used both to seed TARGET_INCOME for a fresh browser
// AND as the one-time migration target for anyone's already-saved band
// values (see the page-load restore IIFE), so nobody's existing numbers
// change just because the editing mechanism did. (Clear All Data
// explicitly zeroes every age's TARGET_INCOME entry as part of that
// specific action -- see _clearAllDataConfirmed() -- rather than changing
// what a normal fresh browser starts with.)
function _defaultTargetForAge(age){
  if(age<65) return 82000;
  if(age<70) return 75000;
  if(age<75) return 68000;
  if(age<80) return 60000;
  return 55000;
}

function _getSpendReal(age){
  const a = Math.max(TARGET_INCOME_MIN_AGE, Math.min(TARGET_INCOME_MAX_AGE, Math.round(age)));
  const v = TARGET_INCOME[a];
  const full = (typeof v === 'number' && !isNaN(v)) ? v : _defaultTargetForAge(a);
  const share = _shareAt(a);
  return share === 1 ? full : Math.round(full * share); // couple mode: this person's share at this age (see _planBudgetTotalsAtAge)
}

function _rrifOverrideFor(age){
  const v = RRIF_OVERRIDE[age];
  return (typeof v === 'number' && !isNaN(v)) ? v : null;
}

function _tfsaOverrideFor(age){
  const v = TFSA_OVERRIDE[age];
  return (typeof v === 'number' && !isNaN(v)) ? v : null;
}

// RRSP meltdown engine helpers -- see meltdownEnabled's declaration above
// for the full rationale. Active window: from retirement through the LAST
// year before both QPP/CPP and OAS have started (once both have started,
// the tax-bracket case for drawing extra weakens, so the meltdown simply
// stops and the plan reverts to its normal mandatory-plus-gap-fill draw).
function _meltdownActive(age, qppStart, oasStart){
  return meltdownEnabled && age < Math.max(qppStart, oasStart);
}

// This year's target GROSS taxable income (DB+LIF+RRIF+QPP/CPP+OAS,
// before tax/clawback) -- the ceiling of whichever federal bracket
// meltdownBracketLevel selects, indexed forward the same way every other
// bracket-based figure in this app is (_idxBrackets, CPI-minus-haircut).
// Referenced against the FEDERAL schedule specifically (not a blended
// federal+provincial rate) -- a deliberate simplification confirmed as
// reasonable during scoping: "fill to a chosen bracket" is the standard
// real-world framing of this strategy, and today's app only ever surfaces
// federal bracket levels as a concept the user picks from (see the Help
// tab's tax-bracket reference table).
function _meltdownTargetIncome(age){
  let level = meltdownBracketLevel;
  if (typeof level !== 'number' || isNaN(level)) level = 2; // guard against an unset/corrupt value -- 0 is a real (if out-of-range) number here, not "unset", so this must NOT use `|| 2`
  level = Math.max(1, Math.min(4, level));
  return _idxBrackets(FED_BRACKETS, age)[level-1].upto;
}

function _rateOverrideFor(kind, age){
  const store = RATE_OVERRIDE[kind];
  if (!store) return null;
  const v = store[age];
  return (typeof v === 'number' && !isNaN(v)) ? v/100 : null;
}

// Applies a hard TFSA override to the "Budget-driven account flow" decision
// every simulate function makes (see the comment above _budgetAnnualNom).
// Forces tfsaDraw to the clamped override value (0..tfsaBal) regardless of
// which branch would otherwise run -- including a would-be surplus/deposit
// year -- skips the normal TFSA deposit/withdrawal computation entirely for
// the year, then re-decides the surplus-or-shortfall split for the
// REMAINING accounts using netInc plus the forced TFSA draw. Any leftover
// surplus routes to Non-Reg (TFSA deposit is skipped by design once
// overridden); any remaining shortfall draws Non-Reg then Emergency Fund,
// same priority every simulate function already uses. Shared across all
// three simulate functions since each has this identical shortfall/surplus
// shape once TFSA is taken out of the decision.
function _applyTfsaOverride(tfsaOv, netInc, budgetAnnualNom, tfsaBal, nonregBal, emergBal){
  const tfsaDraw = Math.max(0, Math.min(tfsaBal, Math.round(tfsaOv)));
  const netWithTfsa = netInc + tfsaDraw;
  if (netWithTfsa >= budgetAnnualNom) {
    return { tfsaDraw, tfsaDep:0, nonregDraw:0, nonregDep:Math.round(netWithTfsa-budgetAnnualNom), emergDraw:0, actualSpend:budgetAnnualNom };
  }
  const need = budgetAnnualNom - netWithTfsa;
  const nonregDraw = Math.round(Math.min(need, nonregBal));
  const emergDraw = Math.round(Math.min(need-nonregDraw, emergBal));
  return { tfsaDraw, tfsaDep:0, nonregDraw, nonregDep:0, emergDraw, actualSpend: netWithTfsa+nonregDraw+emergDraw };
}

// _gapFill() decides how much EXTRA gross LIF/RRIF withdrawal (beyond each
// account's own mandatory minimum) is needed this year to close the gap
// between the year's already-net mandatory income (DB+QPP+OAS+mandatory
// minimums, after real tax/clawback) and the year's real spending target.
//
// A flat "keep rate" guess (e.g. "assume every extra dollar of gross
// withdrawal nets ~70-72 cents after tax") can't reflect Canada's real
// progressive brackets or the OAS clawback's extra 15%, so instead this
// binary-searches the plan's own tax engine (`taxFn` -- `_calcTax` for
// Resident mode, `_calcTaxNonResident` for Non-Resident -- passed in by
// each caller so this stays one shared function instead of forking per
// mode) against this year's real OAS clawback math (`thresh`/`oasAmt`),
// converging on the smallest extra gross withdrawal whose REAL net income
// reaches the spending target. There is no hardcoded dollar ceiling: the
// only bound is the real legal/physical limit already enforced on the
// result right after this function returns (lifMax/lifBal/rrifBal), so a
// retiree with substantial guaranteed income (DB/QPP/OAS) but a real,
// unmet Budget shortfall and real LIF/RRIF room can actually draw it.
function _gapFill(lifBal,rrifBal,lifMin,rrifMand,lifMax,mandGross,thresh,oasAmt,spendTgt,age,taxFn,dbAmt){
  // Real net income if this year's gross mandatory income is topped up by
  // `extraGross` -- the plan's own tax/clawback math, not an assumption.
  // 2026-09-17 (review A12 leftover): the tax here is now evaluated with
  // the SAME pension income amount credit and OAS exclusion the row's own
  // tax uses (_calcTaxDetail(gross, age, eligPension, oas)) -- before, this
  // search ran the tax without the credit, so every year's net income
  // overshot the Target by the credit's value (up to ~$280 at 65+). The
  // eligible pension income is DB at any age plus the whole LIF/RRIF draw
  // (minimums + the extra being searched for) from 65 -- how the extra is
  // later split between LIF and RRIF doesn't change that total. When a
  // caller omits `dbAmt` (none do today) the credit is $0, as before.
  const eligAt = (extraGross) => dbAmt == null ? 0 : _eligiblePensionIncome(age, dbAmt, lifMin + extraGross, rrifMand);
  const netAt = (extraGross) => {
    const gross = mandGross + extraGross;
    const clawbk = Math.max(0, Math.min((gross-thresh)*OAS_CLAWBACK_RATE, oasAmt));
    return gross - taxFn(gross, age, eligAt(extraGross), oasAmt) - clawbk;
  };
  let lifExtra=0,rrifExtra=0;
  if (netAt(0) < spendTgt) {
    // Same physical/legal room already enforced on the result below (LIF
    // capped at its federal maximum; RRIF has none) -- the only real bound
    // on how large "extra" can possibly be, replacing the old flat cap.
    const lifRoom=Math.max(0,Math.min(lifBal-lifMin,lifMax-lifMin));
    const rrifRoom=Math.max(0,rrifBal-rrifMand);
    const maxExtra=lifRoom+rrifRoom;
    if (maxExtra>0) {
      // Binary search for the smallest extra gross withdrawal whose real
      // net income (via taxFn) reaches spendTgt. netAt() is non-decreasing
      // in extraGross -- Canadian marginal tax + OAS clawback never reaches
      // 100%, so every extra gross dollar keeps at least a few cents --
      // which is exactly what a binary search needs to converge correctly.
      // 30 iterations halves a range up to roughly $1 billion down to
      // sub-dollar precision, far more than any realistic balance needs.
      let totalExtra;
      if (netAt(maxExtra) <= spendTgt) {
        totalExtra = maxExtra; // even all the available room can't fully close the gap -- draw all of it
      } else {
        let lo=0, hi=maxExtra;
        for (let i=0;i<30;i++){
          const mid=(lo+hi)/2;
          if (netAt(mid) < spendTgt) lo=mid; else hi=mid;
        }
        totalExtra = Math.round(hi);
      }
      const d=lifBal+rrifBal;
      const lifFrac=d>0?lifBal/d:0;
      lifExtra=Math.round(Math.min(lifRoom,totalExtra*lifFrac));
      rrifExtra=Math.round(Math.min(rrifRoom,totalExtra-lifExtra));
      if(rrifExtra<0) rrifExtra=0;
      const used=lifExtra+rrifExtra;
      if(used<totalExtra) rrifExtra=Math.round(Math.min(rrifRoom,rrifExtra+(totalExtra-used)));
    }
  }
  return {lifExtra,rrifExtra};
}

function _simG(){ if (_engineSettingsOverride) return _engineSettingsOverride.simG; return _numberInputOrDefault('retGrowthRate', 3.5)/100; }

const _SIM_GNREG=0.025, _SIM_GNREG_NONRES=0.030, _TFSA_ROOM0=20000, _TFSA_ANNUAL=7000;
// The TFSA dollar limit is indexed to CPI and rounded to the nearest $500
// (ITA 207.01(1)); $7,000 is the 2026 limit. Grown at the same conservative
// rate as the RRSP limit (_rrspLimitForYear) from the same base year --
// until 2026-09-17 it stayed a flat $7,000 for the whole horizon,
// understating room over a 30-40-year plan (2026-09-16 review, A12).
const _TFSA_ANNUAL_BASE_YEAR=2026;
function _tfsaAnnualLimitForAge(age){
  const years=Math.max(0,_oasProjectionYear(age)-_TFSA_ANNUAL_BASE_YEAR);
  return Math.round(_TFSA_ANNUAL*Math.pow(1+_conservativeRate(),years)/500)*500;
}

// RRSP contribution-room accrual: each year's NEW room = 18% of the PRIOR
// year's earned income, capped at that year's RRSP dollar limit (the real
// CRA rule). _RRSP_ROOM0 is the fallback starting-room guess used only when
// there's no Accumulation-tab projection to carry a real number from
// (manual/preset starting portfolio) — same role _TFSA_ROOM0 plays for
// TFSA.
const _RRSP_ROOM0=30000;

// CRA's 2026 RRSP dollar limit is $33,810 (up from $32,490 in 2025 — see
// https://canadianmoneyhelp.ca/articles/what-changed-rrsp-2026/, confirmed
// 2026-09-11). Grown forward using the same _conservativeRate() escalator
// already used to index tax brackets elsewhere, rather than inventing a
// second, separately-tuned growth assumption for this one dollar figure.
const _RRSP_LIMIT_BASE_YEAR=2026, _RRSP_LIMIT_BASE=33810;

function _rrspDollarLimit(calendarYear){
  return _RRSP_LIMIT_BASE*Math.pow(1+_conservativeRate(), Math.max(0,calendarYear-_RRSP_LIMIT_BASE_YEAR));
}

// Earned income used only for RRSP room accrual — reuses the Budget tab's
// Income field (+ its Pay raise %/yr), the only earned-income figure
// anywhere in this app, compounded forward the same way
// _budgetUpdateRaisePreview()'s (display-only) preview already does.
// yearsFromNow=0 is "today".
// NOTE: salary only, deliberately — this function is also reused as the
// `salaryAnnual` half of _budgetPreRetTotalsAtAge()'s own income figure,
// which adds bonusAnnual separately right after calling it. Adding bonus
// in here too would double-count it there. See _rrspBonusIncomeAt() below
// for the bonus half, used directly by _rrspNewRoomForYear().
function _rrspEarnedIncomeAt(yearsFromNow){
  const annualNow = _budgetIncomeData.amt * (BUDGET_FREQ[_budgetIncomeData.freq] || 1) * 12;
  const raisePct = _budgetIncomeData.raisePct || 0;
  return annualNow * Math.pow(1 + raisePct/100, Math.max(0, yearsFromNow));
}

// RRSP room accrual (_rrspNewRoomForYear() below) is computed from salary
// PLUS the Budget tab's separate Bonus field, consistent with the rest of
// the app: _budgetPreRetTotalsAtAge() (the Year-by-Year table's own
// pre-retirement Income column, and the Budget tab's cash-flow calc)
// already treats "income" as salary+bonus combined, and a regular
// employment bonus (T4 Box 14) counts as earned income for CRA's 18% RRSP
// accrual exactly like salary does. This mirrors
// _budgetPreRetTotalsAtAge()'s own bonusAnnual calculation exactly: the
// Bonus field has no raise %/yr of its own, so (like every other
// non-salary Budget figure without one) it's grown by the plain CPI
// escalation factor instead of the salary's raisePct compounding.
function _rrspBonusIncomeAt(yearsFromNow){
  const annualNow = _budgetBonusData.amt * (BUDGET_FREQ[_budgetBonusData.freq] || 1) * 12;
  return annualNow * Math.pow(1 + _cpiRate(), Math.max(0, yearsFromNow));
}

// Pension Adjustment reduces RRSP room when contributing to a DB pension.
// Real CRA rule is PA = 9 x (this year's accrued DB benefit) - $600, but
// this app's DB Pension section only models a fixed "pension income if you
// started collecting at this age" schedule, not an earnings-linked accrual
// rate -- there's no clean way to derive "benefit accrued this year" from
// that schedule without inventing assumptions the app doesn't otherwise
// track. So this doesn't compute it -- it takes the number straight off
// the T4 slip instead (Box 52 IS the Pension Adjustment CRA already
// calculated for you every year you accrued DB service). One flat input
// (`dbPensionAdjustment`), applied every accrual year the DB pension is in
// use -- no attempt to grow it year over year with salary/raises, keeping
// this a simple input field rather than a second escalating assumption to
// tune. Gated off (returns 0) when DB Pension is excluded via its "Include
// this account" toggle, same convention every other account's fields
// already follow.
function _dbPensionAdjustmentAnnual(){
  if (_engineSettingsOverride) return _engineSettingsOverride.dbPensionAdjustmentAnnual;
  if (_domChecked('useDBPension') === false) return 0;
  return parseFloat(_domValue('dbPensionAdjustment')) || 0;
}

// New RRSP room generated for Accumulation-loop year `yr` (0-based, yr=0 is
// "this year", calendar year startYr+yr): real CRA rule is 18% of the PRIOR
// calendar year's earned income, capped at the CURRENT year's dollar limit,
// minus that same year's Pension Adjustment (see _dbPensionAdjustmentAnnual
// above) if a DB pension is accruing. yr=0 has no "prior year" inside the
// plan, so it falls back to today's own income as the best available
// stand-in for last year's earnings. Not floored at 0 -- a large PA CAN
// legitimately produce a negative net addition for the year (eating into
// previously-accumulated carry-forward room), matching how a real T4's
// Box 52 interacts with your actual CRA deduction limit.
// If the Budget tab's Income field has never been filled in (still $0),
// there's no earned-income figure to work from at all -- rather than
// silently generating $0 new room forever (which would be a worse, and
// completely invisible, regression from the old behavior for anyone not
// using the Budget tab), fall back to the old flat "+$8,000/yr"
// approximation this whole feature otherwise replaces (still PA-adjusted).
function _rrspNewRoomForYear(yr, startYr){
  const pa = _dbPensionAdjustmentAnnual();
  if (!_budgetIncomeData || _budgetIncomeData.amt <= 0) return 8000 - pa;
  const priorYearsOut = Math.max(0, yr-1);
  // Includes Bonus as well as salary -- see _rrspBonusIncomeAt()'s header
  // comment above for why.
  const priorIncome = _rrspEarnedIncomeAt(priorYearsOut) + _rrspBonusIncomeAt(priorYearsOut);
  return Math.min(priorIncome*0.18, _rrspDollarLimit(startYr+yr)) - pa;
}

// Emergency Fund: kept liquid/safe rather than invested, so it grows slower
// than even the non-reg accounts above.
const _SIM_GEMERG=0.015;

// Called once per simulated year from each of the three retirement simulate*
// functions (see their identical call sites, right after `netInc` and
// `_emergencyFundYearFigures` are resolved). Any asset whose conversion age
// falls on or before `age` -- clamped up to retirement age `ra`, since this
// app's retirement simulation never runs before ra -- fires EXACTLY once,
// on the first simulated year at or after that age (ages only ever
// increase by 1 each loop iteration, so effAge===age is true for exactly
// one row per asset, or zero if convertAge is past the simulation horizon).
// Returns the NET (after any tax) dollar amount to add directly to that
// year's nonregDep -- the caller does nothing else: nonregDep already flows
// into nonregBal, nonregInt and nonregACB (dollar-for-dollar fresh cost
// basis) via the exact same lines every other Non-Reg deposit already goes
// through, so a tax-free asset's full value becomes tax-free ACB automatically,
// and a taxable one's post-tax cash becomes its own fresh (already-taxed)
// cost basis -- no new ACB-tracking code needed either.
// `marginalRate` is the caller's own this-year marginal rate (Resident:
// _calcTaxDetail(gross,age).marginal; Non-Resident/Lump:
// _calcTaxDetailNonResident(gross,age).marginal) -- passed in rather than
// computed here so this stays agnostic to which tax regime is calling it.
// Real property remains "taxable Canadian property" for a non-resident even
// though publicly-traded securities are exempt (unlike the rest of Non-Reg
// in the Non-Resident models), so a taxable asset is taxed the same way in
// all three simulate* functions -- no residency special-casing needed here.
function _assetsConversionForYear(age, ra, marginalRate){
  let netDeposit = 0;
  ASSETS.forEach(asset => {
    const convertAge = Math.round(asset.convertAge) || ra;
    // N17 (F4): an asset cannot be sold before the retirement -- but a sale
    // whose age is already behind a re-based start happened in the past and
    // must not fire again, which is why the floor is the retirement age and
    // not the simulation start.
    const effAge = Math.max(convertAge, _retirementAge(ra));
    if (effAge !== age) return;
    const years = Math.max(0, effAge - _personAge());
    const startVal = parseFloat(asset.value) || 0;
    const grown = startVal * Math.pow(1 + (parseFloat(asset.growthPct)||0)/100, years);
    if (asset.taxFree) {
      netDeposit += grown;
    } else {
      // Mirrors nonregStartGainPct's own convention: today's entered value
      // is treated as full cost basis (0% gain already baked in), so only
      // the growth between today and conversion is a capital gain -- same
      // 50%-inclusion, this-year's-marginal-rate treatment already used for
      // Non-Reg's own withdrawal/death capital-gains tax elsewhere. The tax
      // is paid straight out of sale proceeds before the net amount is
      // invested (realistic -- you settle up with CRA out of what you sold
      // for, not by drawing down your other retirement accounts).
      const gain = Math.max(0, grown - startVal);
      const tax = gain * CAP_GAINS_INCLUSION_RATE * marginalRate;
      netDeposit += (grown - tax);
    }
  });
  return Math.round(netDeposit);
}

// Still-unconverted assets' grown value at a given age -- added to Net
// Estate below (computeEstate) so setting a conversion age beyond
// #simEndAge doesn't make that wealth silently vanish from net worth just
// because the simulation never reached the year it would have converted. A
// CONVERTED asset needs no equivalent handling here -- its value is already
// inside the Non-Reg balance via the deposit made when it fired.
function _unconvertedAssetsValueAt(age, ra){
  return _unconvertedAssetsAt(age, ra).gross;
}
// Same, split into the grown value and the still-untaxed capital gain on the
// TAXABLE ones (a tax-free asset -- principal residence -- contributes no
// gain). 2026-09-17 (review A12 leftover): computeEstate() deducts the
// deemed-disposition tax on that gain at death, exactly the 50%-inclusion /
// marginal-rate treatment _assetsConversionForYear() applies to the same
// asset when it is sold inside the horizon -- before, an asset converted at
// 84 paid the tax and the same asset converted at 86 (past an 85 horizon)
// counted at full value.
function _unconvertedAssetsAt(age, ra){
  let gross = 0, gain = 0;
  ASSETS.forEach(asset => {
    const convertAge = Math.round(asset.convertAge) || ra;
    const effAge = Math.max(convertAge, _retirementAge(ra));
    if (effAge > age) {
      const years = Math.max(0, age - _personAge());
      const startVal = parseFloat(asset.value) || 0;
      const grown = startVal * Math.pow(1 + (parseFloat(asset.growthPct)||0)/100, years);
      gross += grown;
      if (!asset.taxFree) gain += Math.max(0, grown - startVal);
    }
  });
  return { gross, gain };
}

// ── Non-Reg tax realism (opt-in, Accumulation tab) ──────────────────────────
// Composition of the Non-Reg account by holding type, and the assumptions
// used to tax each type. Only read/applied when nonregRealisticTax is on;
// every simulate* function falls back to the flat _SIM_GNREG/_SIM_GNREG_NONRES
// rate (100% identical to today's output) when it's off.
function _nonregPretaxReturn(){ if (_engineSettingsOverride) return _engineSettingsOverride.nonregPretaxReturn; return _numberInputOrDefault('nonregPretaxReturn', 6)/100; }

// ACB (adjusted cost base) seeding: what fraction of TODAY's Non-Reg balance
// is already unrealized gain, vs. still-untaxed original principal. Default
// 0% (i.e. assume the whole starting balance is cost basis) is the more
// conservative direction for near-term tax owed, absent better information.
function _nonregStartGainFrac(){ if (_engineSettingsOverride) return _engineSettingsOverride.nonregStartGainFrac; return Math.max(0,Math.min(1,(parseFloat(_domValue('nonregStartGainPct'))||0)/100)); }

// Composition fractions always sum to exactly 1 regardless of what the raw
// inputs add up to (normalized here) — the UI separately warns if they don't
// sum to ~100%, but the simulation itself can never allocate more or less
// than 100% of a year's return this way.
function _nonregMix(){
  if (_engineSettingsOverride) return _engineSettingsOverride.nonregMix;
  const g  = Math.max(0,parseFloat(_domValue('nonregMixGrowth'))||0);
  const cd = Math.max(0,parseFloat(_domValue('nonregMixCanDiv'))||0);
  const fo = Math.max(0,parseFloat(_domValue('nonregMixForeign'))||0);
  const it = Math.max(0,parseFloat(_domValue('nonregMixInterest'))||0);
  const sum = g+cd+fo+it;
  if (sum<=0) return {growth:1,canDiv:0,foreign:0,interest:0};
  return {growth:g/sum, canDiv:cd/sum, foreign:fo/sum, interest:it/sum};
}

// Per-year Non-Reg tax split for the "realistic" mode. `base` is the balance
// the year's growth applies to (matches the flat-rate path's own base
// exactly — see callers). `priorGross` is that year's already-computed
// DB+LIF/RRIF+QPP+OAS taxable income, used only in resident mode as the stacking
// point for marginal-rate purposes (dividends/ordinary income sit on top of
// whatever else is taxable that year, not evaluated from $0).
//
// Returns {nonregInt, acbAdd, taxPaid} where nonregInt is the total balance
// growth for the year (after tax on the buckets that get taxed annually),
// acbAdd is how much of that growth is fresh (already-taxed) cost basis —
// as opposed to unrealized deferred gain — and taxPaid is only exposed for
// diagnostics/testing.
//
// Assumptions (Resident = Canadian resident, Non-Resident = non-resident of
// Canada; see the Part XIII precedent already used elsewhere in this file
// for the pension-income flat-withholding alternative):
//  - Deferred/growth bucket: never taxed annually in either mode. Taxed only
//    on realization (withdrawal or death) — see the ACB-based capital-gains
//    calc in each simulate* function and in computeEstate() — and ONLY in
//    Resident mode: Canada doesn't tax a non-resident's gains on publicly-traded
//    securities (not "taxable Canadian property"), so Non-Resident's deferred
//    bucket is never taxed by Canada at all, ever.
//  - Canadian eligible dividends: Resident — real gross-up(38%)/dividend-tax-
//    credit mechanics (federal 6/11 of the gross-up portion, QC 16.146% —
//    see PROVINCE_TAX_TABLES.quebec.dtcRate),
//    computed against the existing bracket-tax functions rather than a flat
//    rate. Non-Resident — flat Part XIII withholding, final tax, no credits, at
//    the editable rate from the Profile tab's "Canadian dividends" field (see
//    _nrDividendRate() above), which defaults to the same 25% statutory rate
//    this file already documents for pension income, since the treaty
//    doesn't reduce it below the statutory default.
//  - Foreign income: Resident — no special treatment vs. domestic, full ordinary
//    marginal rate (only Canadian ELIGIBLE dividends get the credit). Non-Resident
//    — $0 Canadian tax: Canada only taxes Canadian-source income for a
//    non-resident: whatever the new country of residence charges is out of
//    scope for this Canadian-focused planner.
//  - Interest: Resident — full ordinary marginal rate, same as foreign income for
//    a resident. Non-Resident — flat withholding at the editable rate from the
//    Profile tab's "Canadian interest" field (see _nrInterestRate() above), same
//    conservative default (25%) as dividends (real-world arm's-length
//    interest paid to a non-resident is often statute-exempt, but this
//    file's own stated philosophy is to err toward assuming *more* tax, not
//    less, for a retirement plan).
// Known simplification: this annual tax is computed on the OPENING balance
// for the year (before that year's own draw/deposit), so it doesn't feed
// back into that same year's OAS clawback threshold or spending waterfall —
// it only affects how much of the year's growth compounds into the account.
//
// _nonregTaxSplit() applies identically whether the year's total return is
// the flat deterministic assumption, or Monte Carlo/Sequence-Risk's own
// random draw (both drive every account's growth for the year from their
// own randomized {reg, nonreg} draw -- `yearlyReturns`, see
// simulateResidentFixed's own comment on that parameter): the optional 5th
// parameter `actualTotalReturnRate`, when given, REPLACES only the deferred
// "growth" (price-appreciation) bucket's assumed share of
// `_nonregPretaxReturn()` — the Canadian-dividend/foreign/interest "yield"
// buckets keep compounding, and keep getting taxed annually, at the SAME
// steady assumed rate as any deterministic year. This isn't an arbitrary
// simplification: real-world dividend-paying stocks and interest-bearing
// holdings don't stop distributing cash, or start distributing a NEGATIVE
// amount, just because the broad market had one bad year (many well-known
// dividend payers kept paying through 2008, for instance) — only the
// market PRICE swings with a bad or good year, which is exactly what the
// deferred "growth" bucket is (untaxed until realized, so its
// sign/magnitude flows straight through with no tax-calculation edge
// cases). Concretely: `growthPortion` becomes
// `(base*actualTotalReturnRate) - (canDivPortion+foreignPortion+interestPortion)`
// instead of `totalGrowth*mix.growth` — the leftover after the steady
// yield buckets are set aside — so the account's TOTAL dollar growth for
// the year still matches Monte Carlo/Sequence's own randomized draw exactly
// (a real, randomized ending balance is the whole point of running either
// tool), with only the deferred/untaxed bucket carrying the full swing, up
// or down, even deeply negative in a crash year (a legitimate unrealized
// paper loss, same as a negative flat-rate year already produces today). A
// proportional split of a randomized (and possibly negative) total across
// ALL four buckets was considered and rejected: this app has only ONE
// assumed non-reg return input (`_nonregPretaxReturn()`), not a separate
// rate per income type, so a negative "dividend" or "interest" bucket would
// be a pure math artifact, not a real income-composition insight — and
// feeding it through the same annual dividend/interest tax math as a
// positive year requires floors that would then silently understate real
// losses.
//
// Known interaction (disclosed, not resolvable — no single assumed rate
// exists to unify them): `_nonregPretaxReturn()` (this checkbox's own
// assumed pretax return, e.g. 6%) and Monte Carlo's mean/Sequence-Risk's
// historical mean (independently set, typically closer to this app's flat
// registered growth rate, e.g. ~3.5%) are two separately-configured
// numbers with no enforced relationship. If they're set far apart, the
// deferred "growth" bucket absorbs correspondingly more of the swing
// (since the yield buckets stay anchored at their own steady assumed
// rate) — an intelligible, visibly larger-swinging result, not a crash or
// silent wrong number.
function _nonregTaxSplit(base, priorGross, age, isNonRes, actualTotalReturnRate){
  const mix = _nonregMix();
  const assumedRate = _nonregPretaxReturn();
  const totalGrowth = base * assumedRate; // the deterministic-year assumption; still used for the yield buckets even under a randomized draw (see header comment)
  const canDivPortion   = totalGrowth * mix.canDiv;
  const foreignPortion  = totalGrowth * mix.foreign;
  const interestPortion = totalGrowth * mix.interest;
  const growthPortion = (actualTotalReturnRate != null)
    ? (base * actualTotalReturnRate) - (canDivPortion + foreignPortion + interestPortion)
    : totalGrowth * mix.growth;
  let divTax, ordTax;
  if (isNonRes) {
    divTax = canDivPortion * _nrDividendRate();
    ordTax = interestPortion * _nrInterestRate();
    // foreignPortion: $0 — not Canadian-source income for a non-resident.
  } else {
    const grossedUp = canDivPortion * 1.38;
    const taxAtBase    = _calcTax(priorGross, age);
    const taxWithDiv   = _calcTax(priorGross + grossedUp, age);
    // Federal DTC = 6/11 of the GROSS-UP PORTION only (the 38% add-on,
    // grossedUp-canDivPortion) -- equivalently ~15.02% of the grossed-up
    // taxable amount, the published CRA rate for eligible dividends.
    const pt = PROVINCE_TAX_TABLES[_currentProvince()];
    const fedDTC = (grossedUp - canDivPortion) * (6/11) * (pt.hasFederalAbatement?0.835:1); // same federal-abatement factor _calcTaxDetail applies to fedRaw (QC-only)
    const provDTC = grossedUp * pt.dtcRate;    // selected province's eligible-dividend tax credit rate
    divTax = Math.max(0, (taxWithDiv - taxAtBase) - fedDTC - provDTC);
    const ordinaryExtra = foreignPortion + interestPortion;
    const taxWithOrd = _calcTax(priorGross + grossedUp + ordinaryExtra, age);
    ordTax = Math.max(0, taxWithOrd - taxWithDiv);
  }
  const taxPaid = divTax + ordTax;
  const afterTaxIncome = Math.max(0, (canDivPortion + foreignPortion + interestPortion) - taxPaid);
  return { nonregInt: growthPortion + afterTaxIncome, acbAdd: afterTaxIncome, taxPaid };
}

// ── Budget-driven account flow ──────────────────────────────────────────────
// The deposit/draw to/from savings each year is sized to your real Budget
// need (not Target) directly against actual after-tax income, in ONE
// comparison — not layered on top of a separate Target-vs-income check.
// Layering the two used to cause "double-shoveling": e.g. income beating
// Target would deposit a surplus, while Budget exceeding Target would
// separately draw a shortfall in the same year, even though the true net
// position (income vs Budget) only called for one or the other. Gross
// withdrawals (the LIF/RRIF "extra" draw above, via _gapFill), tax, and
// clawback are unaffected — those stay sized to Target, since that's what
// decides how much to pull out of registered accounts and how it's taxed.
// Guarded like every other _budgetTotalsAtAge() call site in this file — the
// Budget tab's DOM/consts may not exist yet on the very first synchronous
// render, in which case this is simply a no-op (0) for that call.
// Household share (2026-09-17, step 5e): while "Plan as a couple" is on,
// the primary's run funds only its share of the household Budget and
// Target (1 - the spouse's share); the spouse's own run funds the rest.
// The main file sets this; the spouse's person-inputs object carries 1
// (its Budget wrapper already applies the spouse's share -- see
// _spousePersonInputs). The
// Budget tab itself always shows the full household budget --
// _planBudgetTotalsAtAge() is the scaled view the plan consumes.
var _householdPrimaryShare = 1;
function _planBudgetTotalsAtAge(age) {
  const bt = _budgetTotalsAtAge(age) || {};
  const share = _shareAt(age);
  if (share === 1) return bt;
  const out = {};
  for (const k in bt) out[k] = typeof bt[k] === 'number' ? bt[k] * share : bt[k];
  return out;
}
// N20: the part of this age's budget that is not optional. Same shape as
// _budgetAnnualNom below, and it goes through _planBudgetTotalsAtAge too,
// so a couple's share applies to the floor exactly as it does to the total.
function _budgetEssentialAnnualNom(age) {
  try {
    const bt = _planBudgetTotalsAtAge(age);
    return Math.round((bt.essentialTotal || 0) * 12);
  } catch(e) { return 0; }
}
function _budgetAnnualNom(age) {
  try {
    const bt = _planBudgetTotalsAtAge(age);
    return Math.round((bt.nomTotal||0) * 12);
  } catch(e) { return 0; }
}

// The Emergency Fund's own dedicated contribution — pulled straight from the
// Budget tab's "Emergency fund" savings line (already one of BUDGET_SAVINGS,
// and already counted inside _budgetAnnualNom's total need above). Unlike
// every other savings line, this one doesn't just reduce disposable cash —
// it funnels into its own tracked account each year, regardless of whether
// the year as a whole is a surplus or shortfall year (subject to the 6-month
// cap below, once the fund is already full enough).
function _emergencyFundAnnualNom(age) {
  try {
    const it = BUDGET_SAVINGS.find(s=>s.id==='savEmergency');
    const monthly = _budgetItemMonthly(it) * _budgetEscalationFactor(age);
    // Sustainable Spend Scenario overlay -- see sustainSpendActive's header
    // comment. This is a savings line (BUDGET_SAVINGS), so it scales like
    // every other non-debt line, consistent with _budgetTotalsAtAge() above.
    // _effectiveSustainScale(age) is the flat sustainSpendScale in 'uniform'
    // mode, or that same scale shaped by phase in 'phased' mode -- see its
    // own declaration above.
    const spendScale = _effectiveSustainScale(age);
    return Math.round(monthly * 12 * spendScale);
  } catch(e) { return 0; }
}

// Once the Emergency Fund's balance already covers 6 months of real LIVING
// EXPENSES (not the Budget's savings lines sitting alongside them --
// _budgetTotalsAtAge()'s own expenseTotal/savingsTotal split already keeps
// these separate: expenses-only, not the full Budget total), that year's
// dedicated contribution is skipped entirely rather than topping the fund
// up further. Re-evaluated fresh every year, not a one-way switch -- if
// living expenses later outgrow the fund (e.g. inflation), contributions
// resume automatically, even after having stopped in an earlier year.
// Retirement-only -- the Emergency Fund has no tracked running balance
// before retirement at all (see _showAcctHoverPre's own "no
// pre-retirement equivalent" note), so there is nothing to cap pre-
// retirement; this only ever runs from inside the three retirement
// simulate functions, which already track a real emergBal. The freed-up
// contribution needs no new withdrawal-order logic of its own: since
// _budgetAnnualNom() (used for the surplus/shortfall split feeding
// TFSA-then-Non-Reg) already derives from the same per-year
// savings/expense totals, skipping this year's Emergency Fund line there
// too means that money flows into the existing TFSA/Non-Reg surplus
// routing automatically, same as any other surplus dollar.
function _emergencyFundCapReached(age, emergBalSoFar) {
  try {
    const monthlyExpenses = _planBudgetTotalsAtAge(age).expenseTotal || 0;
    return (emergBalSoFar||0) >= monthlyExpenses * 6;
  } catch(e) { return false; }
}

// Combines the capped Emergency Fund contribution decision above with the
// "need" figure (budgetAnnualNom) that decides the surplus/shortfall split
// feeding TFSA-then-Non-Reg, so the two can never drift apart: whatever
// portion of the budgeted contribution is skipped this year is subtracted
// from budgetAnnualNom too. That's what lets the freed-up money flow into
// the existing TFSA/Non-Reg surplus routing automatically, with no new
// withdrawal-order logic needed -- when the cap hasn't been reached, this is
// byte-identical to the old `_emergencyFundAnnualNom(age)` /
// `_budgetAnnualNom(age)` pair (the subtracted amount is exactly 0), so
// every scenario that never reaches 6 months of expenses is unaffected.
// Shared by all three retirement simulate functions instead of tripled inline.
function _emergencyFundYearFigures(age, emergBalSoFar) {
  const budgeted = _emergencyFundAnnualNom(age);
  const emergDep = _emergencyFundCapReached(age, emergBalSoFar) ? 0 : budgeted;
  const budgetAnnualNom = _budgetAnnualNom(age) - (budgeted - emergDep);
  return { emergDep, budgetAnnualNom };
}

// yearlyReturns (optional): array indexed by [age-ra] of {reg, nonreg} annual
// rates (e.g. from the Monte Carlo engine — see runMonteCarloSim). When
// omitted, every year uses the same flat _simG()/_SIM_GNREG rates exactly as
// before — this parameter changes NOTHING about the default deterministic
// output, it only gives a caller a way to vary the rate year-by-year.
// inputs (optional, 2026-09-19): a person-inputs object (see
// _primaryPersonInputs / _spousePersonInputs below) -- the DB pension,
// Target curve, overrides, assets, flags, Budget and engine settings this
// run should read instead of the primary plan's. When omitted, the run
// reads the live plan exactly as before.
// ── One year loop, three residencies (N16 / S1, 2026-09-20) ───────────────
// The year loop existed three times -- resident, non-resident, and the
// non-resident LIF commutation -- with the budget comparison, the deposit
// and draw priority, the rate overrides, the ACB tracking, the balance
// roll-forward and the row shape copied between them and drifting apart at
// the edges. Every engine rule fix was a three-place fix, and only the
// resident copy had ever been taught about per-person inputs and household
// sharing, which is why a non-resident household was impossible by
// construction rather than by decision.
//
// RESIDENCIES is the whole of what actually differs: which tax engine to
// use, how the LIF is drawn, and a handful of defaults and flags. Adding a
// residency is an entry here, not another copy of the loop.
const RESIDENCIES = {
  resident: {
    key: 'resident',
    tfsaRoom0: _TFSA_ROOM0, tfsaRoomGrows: true, tfsaDeposits: true,
    nonregRate: () => _SIM_GNREG,
    // _gapFill needs the plain total; the row needs the detail.
    gapFillTax: (...a) => _calcTax(...a),
    taxDetail: (gross, age, eligPension, oas) => _calcTaxDetail(gross, age, eligPension, oas),
    healthLevy: true,           // the provincial levies ride on the provincial return
    capGainsOnWithdrawal: true, // a Non-Reg withdrawal realises a gain
    nonResSplit: false,         // _nonregTaxSplit's own residency flag
    meltdown: true,             // the RRSP meltdown is a resident strategy
    lifUnlockYear: null,        // no commutation schedule
    // The marginal rate an asset sale is taxed at. Deliberately computed
    // without the pension credit, as it always has been here.
    assetMarginal: (gross, age) => _calcTaxDetail(gross, age).marginal,
  },
  nonresident: {
    key: 'nonresident',
    // No TFSA room accrues while you are not resident, and a non-resident
    // contribution attracts a 1%/month penalty -- so the surplus goes to
    // Non-Reg. Withdrawing from an existing TFSA is still fine.
    tfsaRoom0: 0, tfsaRoomGrows: false, tfsaDeposits: false,
    nonregRate: () => _SIM_GNREG_NONRES,
    gapFillTax: (...a) => _calcTaxNonResident(...a),
    taxDetail: (gross, age, eligPension) => _calcTaxDetailNonResident(gross, age, eligPension),
    healthLevy: false,
    // Canada does not tax a non-resident's capital gains on publicly-traded
    // securities, at withdrawal or at death.
    capGainsOnWithdrawal: false,
    nonResSplit: true,
    meltdown: false,
    lifUnlockYear: null,
    assetMarginal: (gross, age) => _calcTaxDetailNonResident(gross, age).marginal,
  },
  nonresidentLump: {
    key: 'nonresidentLump',
    tfsaRoom0: 0, tfsaRoomGrows: false, tfsaDeposits: false,
    nonregRate: () => _SIM_GNREG_NONRES,
    gapFillTax: (...a) => _calcTaxNonResident(...a),
    // The commutation is a LUMP SUM under Part XIII -- 25%, not the
    // periodic-pension treaty rate -- so the unlock year passes it through.
    taxDetail: (gross, age, eligPension, oas, lumpSum) => _calcTaxDetailNonResident(gross, age, eligPension, lumpSum || 0),
    healthLevy: false,
    capGainsOnWithdrawal: false,
    nonResSplit: true,
    meltdown: false,
    // The full LIF is commuted two years in, once the CRA's two-year
    // non-residency clock has run.
    lifUnlockYear: (ra) => ra + 2,
    // The commutation year's own detail already carries the lump sum, so
    // the sale is taxed at that rate rather than a second computation.
    assetMarginal: (gross, age, taxDet) => taxDet.marginal,
  },
};

// The one year loop. `R` is a RESIDENCIES entry.
function _simulateYears(ra, qppStart, oasStart, customPort, yearlyReturns, R) {
  const port=customPort||{lif:0,rrsp:0,tfsa:0,nonreg:0};
  let lifBal=port.lif, rrifBal=port.rrsp, tfsaBal=port.tfsa, nonregBal=port.nonreg||0, emergBal=0;
  let tfsaRoom=port.tfsaRoom!=null?port.tfsaRoom:R.tfsaRoom0, prevTfsaDraw=0;
  // RRSP room is frozen going into retirement — RRSP fully converts to RRIF
  // at this boundary (rrsp is always 0 from here on) and no more RRSP
  // contributions happen in this model, so unlike tfsaRoom it never grows;
  // it's carried through purely for display (see the RRIF hover box).
  const rrspRoom=port.rrspRoom!=null?port.rrspRoom:_RRSP_ROOM0;
  // Rate override (see RATE_OVERRIDE's header comment, just above
  // _applyTfsaOverride): Monte Carlo/Sequence-of-Returns (`yearlyReturns`)
  // always wins when present, exactly as it already did for the flat rate --
  // an override only ever changes the single deterministic run below.
  const lifRate    = age => yearlyReturns ? yearlyReturns[age-ra].reg    : (_rateOverrideFor('lif',age)    ?? _simG());
  const rrifRate   = age => yearlyReturns ? yearlyReturns[age-ra].reg    : (_rateOverrideFor('rrif',age)   ?? _simG());
  const tfsaRate   = age => yearlyReturns ? yearlyReturns[age-ra].reg    : (_rateOverrideFor('tfsa',age)   ?? _simG());
  const nonregRate = age => yearlyReturns ? yearlyReturns[age-ra].nonreg : (_rateOverrideFor('nonreg',age) ?? R.nonregRate());
  // ACB (adjusted cost base) — tracked unconditionally so computeEstate()
  // always has a real basis to work from, not just when the "realistic tax"
  // toggle is on. Default (toggle off): 100% of growth stays deferred/gain
  // (nothing added to ACB except deposits), matching the flat rate's own
  // implicit "after-tax growth, ~50% cap gains" framing. Composition mode
  // (see _nonregTaxSplit) uses ACB for real: only after-tax div/interest/
  // foreign income that gets reinvested counts as fresh cost basis.
  let nonregACB = (port.nonreg||0) * (1-_nonregStartGainFrac());
  // useRealisticNonreg is not forced off by `yearlyReturns` -- see
  // _nonregTaxSplit's header comment for how the two features combine.
  const useRealisticNonreg = nonregRealisticTax;
  const rows=[];
  const endAge=_simEndAge(ra);
  for(let age=ra;age<=endAge;age++){
    const realSpendTgt=_getSpendReal(age);
    const spendTgt=Math.round(realSpendTgt*Math.pow(1+_cpiRate(),_yearsOut(age)));
    // N14: a survivor's own benefits arrive as this person's income, in
    // their own row -- the DB portion is eligible pension income so it joins
    // `db`; the CPP/QPP survivor's pension is taxable but cannot be split,
    // so it joins `qpp`, which no eligibility test reads.
    const db=Math.round(_getDB(ra,age))+_extraPensionAt(age);
    const qpp=_getQPP(age,qppStart)+_extraOtherAt(age);
    const oas=_getOAS(age,oasStart);
    const thresh=_oasThresh(age);
    // Non-resident: no TFSA room accrues while you are not resident, so the
    // room stays exactly what the plan started with.
    if (R.tfsaRoomGrows) tfsaRoom+=_tfsaAnnualLimitForAge(age)+prevTfsaDraw;
    // Snapshot before this year's deposit (below) consumes it -- "room
    // available this year", which is what the TFSA hover box shows.
    const tfsaRoomYear=tfsaRoom;
    const lifMin=Math.round(lifBal*_lifMinRate(age));
    const lifMax=Math.round(lifBal*_lifMaxRate(age, lifBal));
    const rrifMand=Math.round(rrifBal*_rrifMinRate(age));
    // The LIF commutation schedule, where a residency has one: the whole
    // balance comes out in the unlock year and there is no LIF afterwards.
    // N17 (F4): the two-year non-residency clock runs from the retirement,
    // so a re-based plan does not commute a second LIF.
    const unlockAge = R.lifUnlockYear ? R.lifUnlockYear(_retirementAge(ra)) : null;
    const isUnlockYr = unlockAge != null && age === unlockAge;
    let lif, rrifDraw;
    if (isUnlockYr) {
      lif = Math.round(lifBal);
      rrifDraw = rrifMand;
    } else if (unlockAge != null && age > unlockAge) {
      lif = 0;
      const mandGross=db+rrifMand+qpp+oas;
      const {rrifExtra}=_gapFill(0,rrifBal,0,rrifMand,0,mandGross,thresh,oas,spendTgt,age,R.gapFillTax,db);
      rrifDraw=Math.min(rrifBal,rrifMand+rrifExtra);
    } else {
      const mandGross=db+lifMin+rrifMand+qpp+oas;
      const {lifExtra,rrifExtra}=_gapFill(lifBal,rrifBal,lifMin,rrifMand,lifMax,mandGross,thresh,oas,spendTgt,age,R.gapFillTax,db);
      lif=Math.min(lifBal,lifMax,lifMin+lifExtra);
      rrifDraw=Math.min(rrifBal,rrifMand+rrifExtra);
    }
    // Manual RRIF override — see its declaration above. Upstream of gross/
    // tax/netInc, so a plain value substitution here cascades cleanly
    // through the rest of the pipeline. Floored at the legal mandatory
    // minimum (rrifMand — CRA requires it regardless of what's typed in),
    // capped at the available balance (rrifBal).
    const rrifOv = _rrifOverrideFor(age);
    if (rrifOv != null) {
      rrifDraw = Math.max(rrifMand, Math.min(rrifBal, Math.round(rrifOv)));
    } else if (R.meltdown && _meltdownActive(age, qppStart, oasStart)) {
      // RRSP meltdown -- see _meltdownActive()/_meltdownTargetIncome()'s
      // header comments. Only ever tops the draw UP (Math.max against
      // whatever _gapFill already computed for a real spending need above)
      // and never below rrifBal -- and only runs when there's no manual
      // override for this year, which always wins (see the `if` above).
      const targetGross = _meltdownTargetIncome(age);
      const desiredRrif = targetGross - db - lif - qpp - oas;
      rrifDraw = Math.max(rrifDraw, Math.min(rrifBal, Math.round(desiredRrif)));
    }
    const gross=db+lif+rrifDraw+qpp+oas;
    const clawback=Math.round(Math.max(0,Math.min((gross-thresh)*OAS_CLAWBACK_RATE,oas)));
    // Real eligible pension income (DB at any age; LIF/RRIF only at 65+ --
    // see _eligiblePensionIncome's own comment) feeds the real pension
    // income amount credit.
    const eligPension = _eligiblePensionIncome(age, db, lif, rrifDraw);
    // OAS is passed so the Quebec HSF base excludes it (A7); the lump sum
    // matters only to the commutation year of a residency that has one.
    const taxDet=R.taxDetail(gross,age,eligPension,oas,isUnlockYr?lif:0);
    const tax=Math.round(taxDet.total);
    const healthLevy=taxDet.healthLevy||0;
    const netInc=gross-tax-clawback;
    // External cash flow this year (household sharing, 2026-09-19): a gift
    // received adds to the cash that meets the Budget; a gift made comes
    // out of this year's surplus before it is deposited. Not income, not
    // taxed, not part of netInc (which stays what the tax engine produced);
    // recorded on the row as externalFlow. 0 for a single-person plan.
    // N14: tax-free survivor income (the OAS Allowance) is spendable cash
    // that was never taxed, so it arrives exactly where a gift does.
    const extraTaxFree = _extraTaxFreeAt(age);
    const extFlow = _externalFlowAt(age) + extraTaxFree;
    const cashIn = netInc + extFlow;
    // Emergency Fund: dedicated contribution every year, unless the fund
    // already covers 6 months of living expenses -- see
    // _emergencyFundYearFigures's header comment for the full rationale.
    const { emergDep, budgetAnnualNom } = _emergencyFundYearFigures(age, emergBal);
    let tfsaDraw=0,tfsaDep=0,nonregDraw=0,nonregDep=0,emergDraw=0,actualSpend;
    // Single combined comparison — see "Budget-driven account flow" comment
    // above _budgetAnnualNom. Deposit priority TFSA-then-non-reg; shortfall
    // priority non-reg, then TFSA, then Emergency Fund as the last resort.
    const tfsaOv = _tfsaOverrideFor(age);
    if (tfsaOv != null) {
      // Manual TFSA override — see _applyTfsaOverride's header comment.
      ({tfsaDraw,tfsaDep,nonregDraw,nonregDep,emergDraw,actualSpend} = _applyTfsaOverride(tfsaOv,cashIn,budgetAnnualNom,tfsaBal,nonregBal,emergBal));
    } else if (cashIn >= budgetAnnualNom) {
      const surplus = cashIn - budgetAnnualNom;
      // Deposit priority TFSA-then-Non-Reg, where a TFSA deposit is allowed
      // at all -- a non-resident's whole surplus goes to Non-Reg.
      tfsaDep = R.tfsaDeposits ? Math.round(Math.min(surplus,tfsaRoom)) : 0; tfsaRoom-=tfsaDep;
      nonregDep=Math.round(surplus-tfsaDep);
      actualSpend = budgetAnnualNom;
    } else {
      const need = budgetAnnualNom - cashIn;
      // Draw non-reg before TFSA: non-reg carries an ongoing tax drag just by
      // existing and gets fully taxed as a capital gain at death, while TFSA
      // compounds tax-free forever and passes to beneficiaries tax-free — so
      // it's the account worth preserving longest, not draining first.
      // Emergency Fund only gets touched once both are fully drained.
      nonregDraw=Math.round(Math.min(need,nonregBal));
      tfsaDraw=Math.round(Math.min(need-nonregDraw,tfsaBal));
      emergDraw=Math.round(Math.min(need-nonregDraw-tfsaDraw,emergBal));
      actualSpend=cashIn+tfsaDraw+nonregDraw+emergDraw;
    }
    // Assets (home downsizing, rental sale, etc.) converting THIS year -- see
    // _assetsConversionForYear's header comment. Independent of whichever
    // branch above ran (override/surplus/shortfall): the money always lands
    // in Non-Reg the same way, on top of whatever that branch already put
    // there. nonregDep flows into nonregBal/nonregInt/nonregACB below via
    // the exact same lines every other Non-Reg deposit already uses.
    nonregDep += _assetsConversionForYear(age, ra, R.assetMarginal(gross, age, taxDet));
    // Non-Reg capital-gains tax on THIS year's withdrawal (ACB-based —
    // realistic mode only; resident only, Non-Resident's public-securities
    // exemption keeps this $0, handled directly in the non-resident simulate
    // functions). Unlike DB/LIF/RRIF/QPP/OAS — whose tax is already baked
    // into netInc before it's ever compared to budget — this tax is only
    // known AFTER the withdrawal decision above, so it can't be grossed up
    // the same way. Fixed here by drawing the tax bill from TFSA (tax-free,
    // same account the plan already prefers over Emergency Fund) and then
    // Emergency Fund, same priority order as any other spending need — so a
    // realistic-tax capital-gains bite doesn't register as a "shortfall"
    // while those accounts still have room. Only whatever TFSA+Emergency
    // Fund together can't cover becomes a real shortfall. (Still doesn't
    // feed back into this year's clawback/tax above — see
    // _nonregTaxSplit's header comment for that separate simplification.)
    const nonregGainFrac = nonregBal>0 ? Math.max(0,(nonregBal-nonregACB)/nonregBal) : 0;
    // This capital-gains tax bite (computed and paid from TFSA/Emergency
    // Fund, below) is hoisted out of the `if` block so it's always defined
    // (0 when not applicable) and gets stored on the row -- see
    // _taxCostBreakdown()'s header comment.
    let nonregCapGainsTax = 0;
    if (R.capGainsOnWithdrawal && useRealisticNonreg && nonregDraw>0) {
      nonregCapGainsTax = Math.round(nonregDraw*nonregGainFrac*CAP_GAINS_INCLUSION_RATE*_calcTaxDetail(gross,age).marginal);
      if (nonregCapGainsTax > 0) {
        // A hard TFSA override keeps the draw at exactly the typed amount —
        // this top-up isn't allowed to pull extra from TFSA on top of it, so
        // the cap-gains bite falls through to Emergency Fund instead.
        const extraFromTfsa = tfsaOv != null ? 0 : Math.round(Math.min(nonregCapGainsTax, Math.max(0, tfsaBal-tfsaDraw)));
        tfsaDraw += extraFromTfsa;
        const stillNeeded = nonregCapGainsTax - extraFromTfsa;
        const extraFromEmerg = Math.round(Math.min(stillNeeded, Math.max(0, emergBal-emergDraw)));
        emergDraw += extraFromEmerg;
        const uncovered = stillNeeded - extraFromEmerg;
        actualSpend = Math.max(0, actualSpend-uncovered);
      }
    }
    prevTfsaDraw=tfsaDraw; // after the cap-gains top-up above, so next year's TFSA room reflects the real total draw
    const shortfall=Math.max(0,Math.round(budgetAnnualNom-actualSpend));
    // N20: "fully funded" and "the floor held" are different questions, and
    // only the second one is an emergency. A year can miss its budget by a
    // wide margin and still cover everything that was not optional.
    // The floor can never exceed the budget the year is actually funding:
    // the essential groups are a SUBSET of the expenses, and savings are
    // excluded from the floor entirely. Without this cap the two are
    // rounded independently -- _budgetEssentialAnnualNom() rounds the
    // essential annual total, while budgetAnnualNom is a rounded budget
    // minus a separately rounded Emergency Fund contribution (see
    // _emergencyFundYearFigures) -- so a plan whose savings are almost all
    // Emergency Fund and whose expense groups are almost all essential
    // lands $1 apart and reports a fully funded year as an essential
    // shortfall. Reported by JP 2026-09-20: "$1 short of a $93,192 floor".
    // Capping makes essentialShortfall <= shortfall an identity rather
    // than something that holds to within a rounding error.
    const essentialNom=Math.min(_budgetEssentialAnnualNom(age), budgetAnnualNom);
    const essentialShortfall=Math.max(0,Math.round(essentialNom-actualSpend));
    const rLif=lifRate(age), rRrif=rrifRate(age), rTfsa=tfsaRate(age), rNonreg=nonregRate(age);
    const lifInt=Math.round(Math.max(0,lifBal-lif)*rLif);
    const rrifInt=Math.round(Math.max(0,rrifBal-rrifDraw)*rRrif);
    const tfsaInt=Math.round(Math.max(0,tfsaBal-tfsaDraw+tfsaDep)*rTfsa);
    const nonregBase=Math.max(0,nonregBal-nonregDraw+nonregDep);
    let nonregInt,nonregAcbAdd;
    // _nonregTaxSplit() also computes real tax on THIS year's Non-Reg
    // dividend/interest income (`taxPaid` -- already netted out of
    // nonregInt/acbAdd before either is used, so the account balance itself
    // is always correct); nonregDivIntTax stores that on the row so it
    // reaches _taxCostBreakdown()'s total the way nonregCapGainsTax (a
    // sibling Realistic-Non-Reg tax cost, above) does. Same "hoisted so
    // it's always defined" pattern as nonregCapGainsTax.
    let nonregDivIntTax = 0;
    if (useRealisticNonreg) {
      // yearlyReturns present -> rNonreg IS this year's Monte Carlo/Sequence-
      // Risk random draw (see _nonregTaxSplit's header comment); otherwise
      // null so the deterministic assumed pretax return applies as always
      // (a manual per-year rate override on Non-Reg is still ignored here,
      // unchanged/documented -- see the Rate-column tooltip).
      const split=_nonregTaxSplit(nonregBase,gross,age,R.nonResSplit,yearlyReturns?rNonreg:null);
      nonregInt=Math.round(split.nonregInt); nonregAcbAdd=split.acbAdd; nonregDivIntTax=Math.round(split.taxPaid);
    } else {
      nonregInt=Math.round(nonregBase*rNonreg); nonregAcbAdd=0;
    }
    const emergInt=Math.round(Math.max(0,emergBal-emergDraw+emergDep)*_SIM_GEMERG);
    rows.push({age,db,lif:Math.round(lif),rrsp:0,rrif:Math.round(rrifDraw),qpp,oas,clawback,
      lifMin,lifMax,rrifMin:rrifMand,tfsaRoom:tfsaRoomYear,rrspRoom,
      tfsa:Math.round(tfsaDraw),nonreg:Math.round(nonregDraw),emerg:Math.round(emergDraw),
      totalTaxable:Math.round(gross),tax,healthLevy,healthLevyItems:taxDet.healthLevyItems,spendTarget:realSpendTgt,
      // N15 (S4): the tax detail this row's own tax came from. The Tax
      // sub-tab and the Year-by-Year tax hover used to re-run
      // _calcTaxDetail per row to get these, which agreed with the row's
      // real tax only while the engine's settings and the UI's were the
      // same object at the same moment -- during N7 they briefly were not
      // and the tab showed $68,214 against the row's $53,533.
      taxFed:taxDet.fed,taxProv:taxDet.prov,taxMarginal:taxDet.marginal,taxEffective:taxDet.effective,
      taxMethod:taxDet.method,taxFlat:taxDet.flatTax,taxElected:taxDet.electedTax,
      totalSpend:Math.round(actualSpend),shortfall,essentialNom,essentialShortfall,nonregCapGainsTax,nonregDivIntTax,
      externalFlow:extFlow,extraTaxFree,
      surplus:tfsaDep,nonregDeposit:Math.round(nonregDep),emergDeposit:Math.round(emergDep),
      lifBal:Math.round(lifBal),rrspBal:Math.round(rrifBal),
      tfsaBal:Math.round(tfsaBal),nonregBal:Math.round(nonregBal),emergBal:Math.round(emergBal),
      nonregACB:Math.round(nonregACB),
      lifRatePct:rLif*100,rrifRatePct:rRrif*100,tfsaRatePct:rTfsa*100,nonregRatePct:rNonreg*100,
      lifInt,rrifInt,tfsaInt,nonregInt,emergInt,lifUnlocked:isUnlockYr});
    lifBal=Math.max(0,(lifBal-lif)*(1+rLif));
    rrifBal=Math.max(0,(rrifBal-rrifDraw)*(1+rRrif));
    tfsaBal=Math.max(0,(tfsaBal-tfsaDraw+tfsaDep)*(1+rTfsa));
    // ACB update: withdrawals reduce ACB by their return-of-capital share
    // (nonregGainFrac, computed above from this year's OPENING balance/ACB),
    // deposits add dollar-for-dollar, and (realistic mode only) after-tax
    // reinvested div/interest/foreign income also adds fresh cost basis.
    // Deferred/growth-bucket appreciation never touches ACB.
    nonregACB=Math.max(0, nonregACB-nonregDraw*(1-nonregGainFrac)+nonregDep+nonregAcbAdd);
    nonregBal = useRealisticNonreg
      ? Math.max(0, nonregBase+nonregInt)
      : Math.max(0,(nonregBal-nonregDraw+nonregDep)*(1+rNonreg));
    emergBal=Math.max(0,(emergBal-emergDraw+emergDep)*(1+_SIM_GEMERG));
    // Closing balances/ACB for THIS row: the real post-growth values this
    // year's loop just computed above, using whichever rate actually
    // applied (a flat assumption, a per-year manual override, Monte
    // Carlo/Reverse-Sequence's yearlyReturns, or Realistic Non-Reg tax's
    // composition-based nonregInt) -- exactly the same values that become
    // next row's OPENING balance for every row except the last. The last
    // row has no next row, so without this its final year of real growth
    // would be silently discarded when computed elsewhere from a flat,
    // mode-wide rate instead. See computeEstate()'s own header comment for
    // the consuming side of this.
    rows[rows.length-1].lifBalClose=Math.round(lifBal);
    rows[rows.length-1].rrspBalClose=Math.round(rrifBal);
    rows[rows.length-1].tfsaBalClose=Math.round(tfsaBal);
    rows[rows.length-1].nonregBalClose=Math.round(nonregBal);
    rows[rows.length-1].nonregACBClose=Math.round(nonregACB);
    rows[rows.length-1].emergBalClose=Math.round(emergBal);
  }
  return rows;
}

// The three public names are wrappers over the one loop above, so no
// caller changed when it was unified (N16 / S1).
function simulateResidentFixed(ra, qppStart, oasStart, customPort, yearlyReturns, inputs) {
  if (inputs) return _withPersonInputs(inputs, () => simulateResidentFixed(ra, qppStart, oasStart, customPort, yearlyReturns));
  return _simulateYears(ra, qppStart, oasStart, customPort, yearlyReturns, RESIDENCIES.resident);
}

// yearlyReturns: see simulateResidentFixed's comment above.
function simulateNonResident(ra, qppStart, oasStart, customPort, yearlyReturns) {
  return _simulateYears(ra, qppStart, oasStart, customPort, yearlyReturns, RESIDENCIES.nonresident);
}

// ── 100% LIF→Non-Reg unlock variant (Non-Resident's "100%→Non-Reg" LIF choice) ──
// A resident doesn't have a valid unlocking ground for a full LIF
// unlock under the Pension Benefits Standards Act — only the 50% LIF→RRIF
// option applies while resident. This full-unlock strategy is only modeled
// for the Non-Resident scenario, via the 2-year non-residency ground.
//
// Years 1-2: the FULL (untouched) LIF draws under the normal federal
// max/min-capped rules — the maximum allowed by law — while the 2-year
// non-residency clock runs. Year 3: the entire remaining LIF balance (100%,
// not just a partial amount) is fully commuted as one taxable lump sum, with
// after-tax proceeds landing in non-reg (a commutation payment can't be
// re-registered into the TFSA). This is mutually exclusive with the separate
// "50% LIF→RRIF unlock" choice for this scenario — see nrLifUnlock.
// yearlyReturns: see simulateResidentFixed's comment above.
function simulateNonResidentLump(ra, qppStart, oasStart, customPort, yearlyReturns) {
  return _simulateYears(ra, qppStart, oasStart, customPort, yearlyReturns, RESIDENCIES.nonresidentLump);
}

// One-time 50% LIF→RRSP/RRIF unlock: a tax-free registered-to-registered
// transfer that moves half the LIF balance out from under LIF minimum/
// maximum rules into ordinary RRIF rules (minimum only, no maximum). Not a
// taxable event. The MECHANICAL transfer below is identical everywhere it's
// used — Canada Resident's checkbox and Non-Resident's "50%→RRIF" LIF
// choice both call this same function — but WHEN it's actually legal to use
// differs a lot by jurisdiction and mode:
//  - Canada Resident: gated by the real province-specific (or, for a
//    federally regulated pension, federal) one-time-unlock rule — see
//    _halfUnlockAllowed() just below, which enforces this.
//  - Non-Resident's "50%→RRIF" choice (nrLifUnlock): modeled as generally
//    available, under the federal RLIF/PBSR mechanism already described
//    where nrLifUnlock is used — ungated by province, since Non-Resident's
//    LIF choice already models a different (2-year non-residency-adjacent)
//    federal provision, not the provincial ones this comment is about.
function _forceHalfSplit(port) {
  const moved = Math.round((port.lif||0) * 0.5);
  return {...port, lif: (port.lif||0) - moved, rrsp: (port.rrsp||0) + moved};
}

// Whether Canada Resident's one-time 50% LIF→RRSP/RRIF transfer is actually
// available, per the REAL rule for whichever pension jurisdiction applies —
// researched directly against each regulator (2026):
//  - Federally regulated pension (the "Federally regulated pension" override
//    checkbox on the DC Pension box — see _provLifMaxRate above): OSFI's
//    RLIF rule — age 55+ within the calendar year, exercised within 60 days
//    of the RLIF being funded. This planner treats retirement as the LIF/
//    RLIF-conversion moment, so "age 55+ within the calendar year" is what's
//    modeled — the 60-day window is then automatically satisfied.
//  - Ontario: Schedule 1.1, FSRA Form 5.2 — NO age requirement at all,
//    exercised within 60 days of the Schedule 1.1 LIF being funded. Same
//    "retirement = conversion moment" reasoning means this is simply always
//    available.
//  - Alberta: exercised BEFORE the LIRA converts to a LIF (not after), and
//    requires age 50+ — the gate that matters here.
//  - Quebec and British Columbia: confirmed directly against Retraite
//    Québec and BCFSA — NEITHER has any one-time percentage-based unlocking
//    provision at all. (Quebec's LIF already has no withdrawal-percentage
//    cap of any kind since the 2025 reform — see _provLifMaxRate above —
//    which may be why no separate unlock mechanism exists there.)
// Alberta's `ra >= 50` branch and BC's inclusion in the "no such provision"
// fallback are reachable only via a test-injected dropdown option (see
// PROVINCE_TAX_TABLES' comment) — left untouched so both
// provinces' real rules are ready the moment either <option> comes back.
function _halfUnlockAllowed(ra) {
  if (_federallyRegulated()) return ra >= 55;
  const prov = _currentProvince();
  if (prov === 'ontario') return true;
  if (prov === 'alberta') return ra >= 50;
  return false; // quebec, bc: no such provision
}

// Human-readable reason the transfer is unavailable, for the checkbox's
// tooltip — kept in sync with _halfUnlockAllowed() above.
function _halfUnlockUnavailableReason(ra) {
  if (_federallyRegulated()) return `federally regulated pensions can only use this at age 55+ (you're modeling retirement at ${ra}).`;
  const prov = _currentProvince();
  if (prov === 'alberta') return `Alberta requires age 50+ (you're modeling retirement at ${ra}).`;
  if (prov === 'quebec') return 'Quebec has no one-time unlocking provision — its LIF already has no withdrawal-percentage cap at all.';
  if (prov === 'bc') return 'British Columbia has no one-time unlocking provision of this kind.';
  return 'not available for the selected province.';
}

function _applyHalfUnlock(port) {
  // Canada Resident's checkbox only. Non-Resident has its own separate
  // 3-way choice (nrLifUnlock), applied inside _runSim() instead.
  if (!halfUnlock) return port;
  return _forceHalfSplit(port);
}

// Dispatches to the right simulation function + portfolio transform for a
// given mode. Centralizing this avoids the halving being applied twice (once
// here, once inside a simulate function) or not at all.
// A sequence of yearly returns a stress wants every _runSim() in its scope
// to use, when the caller does not pass one itself (N11, 2026-09-20). Set
// and restored by _withStress()'s sequence-event branch; null the rest of
// the time. One guard here rather than a sixth argument threaded through
// every call site in the sensitivity table and the recommendation search.
var _stressYearlyReturns = null;
// The residency the CURRENT plan runs under. Until N16 unified the year
// loop there was nothing to return here, which is the whole reason a
// non-resident household was impossible: runSpouseSim and the household
// merge could only ever call the resident engine.
function _currentResidency() {
  if (spendMode === 'nonresident') return nrLifUnlock === 'full' ? RESIDENCIES.nonresidentLump : RESIDENCIES.nonresident;
  return RESIDENCIES.resident;
}
function _runSim(mode, ra, qpp, oas, rawPort, yearlyReturns) {
  yearlyReturns = yearlyReturns || _stressYearlyReturns || undefined;
  if (mode==='resident')    return simulateResidentFixed(ra, qpp, oas, _applyHalfUnlock(rawPort), yearlyReturns);
  if (mode==='nonresident') {
    if (nrLifUnlock==='half') return simulateNonResident(ra, qpp, oas, _forceHalfSplit(rawPort), yearlyReturns); // 50%→RRIF, no lump ever
    if (nrLifUnlock==='full') return simulateNonResidentLump(ra, qpp, oas, rawPort, yearlyReturns);               // 100%→Non-Reg in yr 3
    return simulateNonResident(ra, qpp, oas, rawPort, yearlyReturns); // 'none': LIF untouched, draws at the federal max like every other account
  }
  return [];
}

// --- Net Estate --------------------------------------------------------------
// Moved here from the main file on 2026-09-17: pure calculation over the
// final simulation row + the tax engine (2026-09-16 review, A12).
function computeEstate(rows) {
  const last = rows[rows.length-1];
  // rows[0].age is always the retirement age every simulate* function's loop
  // starts from -- needed below so an asset not yet converted by the end of
  // the simulated horizon still counts toward net worth (see
  // _unconvertedAssetsValueAt's header comment).
  const ra = rows[0].age;
  const isNonRes = spendMode==='nonresident';
  // All four balances below are read directly from each simulate function's
  // own captured closing balance (simulateResidentFixed/simulateNonResident/
  // simulateNonResidentLump -- see those functions' "Closing balances"
  // comment), not re-derived by multiplying the last row's opening balance
  // by a single flat, mode-wide rate. That keeps this correct under every
  // rate source a given final year might actually have used -- a per-year
  // manual return override, Monte Carlo/Reverse-Sequence-Risk's
  // yearlyReturns, or Realistic Non-Reg tax's composition-based growth --
  // with no special-casing needed here.
  const estLif    = last.lifBalClose    ?? 0;
  const estRrsp   = last.rrspBalClose   ?? 0;
  const estTfsa   = last.tfsaBalClose   ?? 0;
  const estNonregGross = last.nonregBalClose ?? 0;
  const estEmerg  = last.emergBalClose  ?? 0;
  // Non-Reg death tax: Net Estate deducts capital-gains tax on the
  // account's unrealized gain at death, using the ACB (adjusted cost base)
  // tracked alongside the balance through the simulation.
  //  - Resident: 50% inclusion rate on the unrealized gain, taxed at
  //    this year's combined marginal rate (_calcTaxDetail's own .marginal).
  //  - Non-Resident: $0 — publicly-traded securities are excluded
  //    from "taxable Canadian property", so Canada doesn't tax a
  //    non-resident's capital gains on them, including at death.
  // finalACB is the CLOSING ACB (nonregACBClose), matching the closing
  // (post-growth) gross balance it's subtracted from above. Using the
  // row's OPENING ACB (before the final year's own withdrawal/deposit/
  // reinvestment activity) against a closing-balance gross figure would be
  // an inconsistent opening-vs-closing mix that overstates the unrealized
  // gain -- and so the death tax -- by that year's own ACB change. Falls
  // back to the older nonregACB field only for a row that doesn't have a
  // closing ACB.
  const finalACB = last.nonregACBClose ?? last.nonregACB ?? 0;
  const nonregGain = Math.max(0, estNonregGross - finalACB);
  // Marginal rate evaluated at the final year's own taxable income (not at
  // the gain amount in isolation) — the gain stacks on top of whatever
  // else is taxable that year, so this approximates the rate on that last
  // dollar rather than understating it by pretending the gain starts from $0.
  // 2026-09-17 (second review, M1): the gain is realised on the SAME final
  // return as the registered balance below, so its marginal rate is read
  // after that balance is stacked on the year's income -- not at the
  // year's regular income alone, which understated it whenever the
  // registered balance pushed the return into higher brackets.
  const deathMarginal = isNonRes ? 0 : _calcTaxDetail((last.totalTaxable||0) + (last.lifBalClose ?? 0) + (last.rrspBalClose ?? 0), last.age, 0, last.oas||0).marginal;
  const nonregDeathTax = Math.round(nonregGain * CAP_GAINS_INCLUSION_RATE * deathMarginal);
  // A RRIF/RRSP/LIF has no spousal rollover modeled here, so under real CRA
  // rules its ENTIRE remaining fair market value is included as ordinary
  // income on the deceased's final return (unlike Non-Reg's 50%-inclusion
  // capital gain above), regardless of the plan's real bracket structure
  // that year, its real province, or how far a balance that large (often
  // the single biggest number in the whole estate) actually pushes through
  // the higher brackets beyond wherever that year's regular income already
  // reached. registeredDeathTax below computes the REAL incremental tax of
  // stacking the full registered balance on top of the final year's own
  // real taxable income, using the plan's
  // actual bracket-by-bracket tax engine (the before/after TOTAL, not a
  // single marginal-rate point at the margin like nonregDeathTax above --
  // a lump sum this large routinely spans several additional brackets, so
  // only the full before/after delta captures that correctly). Applies in
  // both modes: a non-resident's RRIF/LIF is real Part XIII-withheld
  // income at death too (unlike Non-Reg's publicly-traded-securities
  // exemption, which has no registered-account equivalent), so this uses
  // whichever tax engine (_calcTaxDetail / _calcTaxDetailNonResident) the
  // rest of this function already selected via `isNonRes`.
  const registeredBal = estLif + estRrsp;
  const taxFn = isNonRes ? _calcTaxDetailNonResident : _calcTaxDetail;
  const baseIncome = last.totalTaxable||0;
  // Real eligible pension income for the final simulated year itself (DB +
  // LIF/RRIF actually drawn that year, age-gated -- same definition used
  // everywhere else) -- applies to BOTH the before/after evaluations below
  // since the pension
  // income amount is capped by income actually received that year, not by
  // the account's remaining balance being added on top of it.
  const finalEligPension = _eligiblePensionIncome(last.age, last.db, last.lif, last.rrif);
  // Non-Resident (2026-09-17 second review, H3): the registered balance
  // paid out at death is a LUMP SUM under Part XIII -- 25%, not the
  // periodic-pension treaty rate -- so it is passed as lumpSumIncome, the
  // same way the year-3 LIF commutation already is. Resident: the OAS
  // amount is passed so the Quebec HSF base matches the row's own tax (L3).
  const registeredDeathTax = registeredBal>0
    ? Math.max(0, Math.round((isNonRes ? taxFn(baseIncome+registeredBal,last.age,finalEligPension,registeredBal) : taxFn(baseIncome+registeredBal,last.age,finalEligPension,last.oas||0)).total
                             - (isNonRes ? taxFn(baseIncome,last.age,finalEligPension,0) : taxFn(baseIncome,last.age,finalEligPension,last.oas||0)).total))
    : 0;
  // Any asset (home, rental, etc.) whose chosen conversion age falls AFTER
  // the simulated horizon (#simEndAge) never fires inside the rows above --
  // it's still owned at death, so its own (still-growing) value counts
  // toward Net Estate too. A CONVERTED asset needs nothing here: its value
  // already lives inside estNonregGross via the deposit made when it fired.
  const unconv = _unconvertedAssetsAt(last.age, ra);
  const estUnconvertedAssets = unconv.gross;
  // 2026-09-17 (review A12 leftover, "estate deemed disposition"): the
  // still-owned TAXABLE assets are deemed disposed of at death too -- same
  // 50%-inclusion, this-year's-marginal-rate treatment the same asset gets
  // from _assetsConversionForYear() when it is sold inside the horizon.
  // Real property is taxable Canadian property for a non-resident as well
  // (unlike the publicly-traded securities in Non-Reg), so this applies in
  // both modes, at whichever regime's marginal rate.
  // Non-Resident (second review, M2): a gain on taxable Canadian property
  // is taxed under Part I -- graduated federal rates + the s.120(1) 48%
  // surtax -- never at the Part XIII pension withholding rate.
  const assetMarginal = isNonRes ? _fedMarginalRate(baseIncome + registeredBal, last.age) * 1.48 : deathMarginal;
  const unconvertedDeathTax = Math.round(unconv.gain * CAP_GAINS_INCLUSION_RATE * assetMarginal);
  // 2026-09-17 (review A12 leftover, "final-return OAS clawback"): the
  // final return stacks the whole registered balance and the taxable half
  // of the deemed capital gains on top of the last year's income, so the
  // OAS received that year is (re)tested against that much larger income.
  // Only the INCREMENT over the clawback the row already charged is
  // deducted; capped at the OAS actually received, so it can never exceed
  // what a full clawback would take.
  const finalIncome = baseIncome + registeredBal + nonregGain * CAP_GAINS_INCLUSION_RATE + unconv.gain * CAP_GAINS_INCLUSION_RATE;
  const oasFinal = Math.max(0, last.oas || 0);
  const fullClaw = Math.max(0, Math.min((finalIncome - _oasThresh(last.age)) * OAS_CLAWBACK_RATE, oasFinal));
  const finalClawback = Math.max(0, Math.round(fullClaw - (last.clawback || 0)));
  // nonreg/lif/rrif (the figures each card itself displays) all stay GROSS
  // -- death tax is applied only inside `net`, so every card in the grid
  // shows a pre-tax balance and only the "Net Estate" total reflects tax.
  // nonregDeathTax/registeredDeathTax/unconvertedDeathTax/finalClawback
  // are exposed separately so each card's caption can show its own real
  // computed tax instead of a static guess.
  const net = estTfsa + (estNonregGross-nonregDeathTax) + estEmerg + (registeredBal-registeredDeathTax) + (estUnconvertedAssets-unconvertedDeathTax) - finalClawback;
  return { lif:Math.round(estLif), rrif:Math.round(estRrsp), tfsa:Math.round(estTfsa), nonreg:Math.round(estNonregGross), nonregDeathTax, registeredDeathTax, emerg:Math.round(estEmerg), unconvertedAssets:Math.round(estUnconvertedAssets), unconvertedDeathTax, finalClawback, net:Math.round(net) };
}

// --- Monte Carlo / sequence-of-returns risk engine -------------------------
// Everything below is purely additive and opt-in: nothing here runs unless a
// caller explicitly invokes runMonteCarloSim(), and it never touches liveData,
// currentAge, or any other global the deterministic rendering path reads.
//
// Box-Muller transform: converts two uniform (0,1) samples into a normally-
// distributed sample with the given mean/stdev. Standard, no external library
// needed. Guards against u1===0 (log(0) = -Infinity) by re-rolling.
function _randNormal(mean, stdev) {
  let u1 = 0;
  while (u1 === 0) u1 = _rng();
  const u2 = _rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stdev * z;
}

// --- Historical bootstrap (deferred half of the Monte Carlo item; JP chose
// "Monte Carlo first" earlier, then picked this up as a follow-on) ---------
// S&P 500 total annual returns (price change + reinvested dividends),
// 1926-2025 — 100 calendar years, chronological order. Source: slickcharts.com
// "S&P 500 Total Returns by Year", cross-referenced against the standard
// Ibbotson/SBBI-derived series long used in US retirement-planning tools
// (e.g. FIRECalc, cFIREsim). The partial, not-yet-closed 2026 year is
// deliberately excluded. This is a US equity series used here purely as a
// SHAPE/sequencing proxy (see _standardizedHistShocks below) — not a claim
// that JP's actual registered/non-reg accounts are S&P 500-only, or
// Canadian. JP's call, when asked (Canadian S&P/TSX Composite was the
// alternative on offer): the TSX series available is only 37 years
// (1988-2024) and excludes dividends, too short and too incomplete to
// capture a genuine depression-scale event the way this 100-year window
// does — https://www.slickcharts.com/sp500/returns.
const SP500_ANNUAL_RETURNS_START_YEAR = 1926;

const SP500_ANNUAL_RETURNS = [
  0.1162, 0.3749, 0.4361, -0.0842, -0.2490, -0.4334, -0.0819, 0.5399, -0.0144, 0.4767, // 1926-1935
  0.3392, -0.3503, 0.3112, -0.0041, -0.0978, -0.1159, 0.2034, 0.2590, 0.1975, 0.3644,  // 1936-1945
  -0.0807, 0.0571, 0.0550, 0.1879, 0.3171, 0.2402, 0.1837, -0.0099, 0.5262, 0.3156,    // 1946-1955
  0.0656, -0.1078, 0.4336, 0.1196, 0.0047, 0.2689, -0.0873, 0.2280, 0.1648, 0.1245,    // 1956-1965
  -0.1006, 0.2398, 0.1106, -0.0850, 0.0386, 0.1430, 0.1900, -0.1469, -0.2647, 0.3723,  // 1966-1975
  0.2393, -0.0716, 0.0657, 0.1861, 0.3250, -0.0492, 0.2155, 0.2256, 0.0627, 0.3173,    // 1976-1985
  0.1867, 0.0525, 0.1661, 0.3169, -0.0310, 0.3047, 0.0762, 0.1008, 0.0132, 0.3758,     // 1986-1995
  0.2296, 0.3336, 0.2858, 0.2104, -0.0910, -0.1189, -0.2210, 0.2868, 0.1088, 0.0491,   // 1996-2005
  0.1579, 0.0549, -0.3700, 0.2646, 0.1506, 0.0211, 0.1600, 0.3239, 0.1369, 0.0138,     // 2006-2015
  0.1196, 0.2183, -0.0438, 0.3149, 0.1840, 0.2871, -0.1811, 0.2629, 0.2502, 0.1788,    // 2016-2025
];

function _mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function _stdevSample(arr) {
  const m = _mean(arr);
  const sumSq = arr.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(sumSq / (arr.length - 1));
}

// Computed once from the constant array above: the dataset's own real
// long-run mean/stdev (shown for reference in the UI — see mc results
// below) and every year standardized to a z-score, (r-mean)/stdev. The
// bootstrap below resamples FROM these z-scores rather than the raw
// percentages, so a run's mean/volatility stays whatever meanPct/stdevPct
// the caller supplies (same knobs the Normal model uses) — the historical
// data contributes only the realistic shape/sequencing (fat tails,
// autocorrelation, real crash-and-recovery timing) of the shocks, not an
// unrelated absolute return level. JP's call, when asked (the alternative
// was replaying the S&P 500's own ~12% long-run average directly): this
// dataset's real average is well above the app's existing conservative
// planning assumptions, so overriding the mean would make this mode look
// much rosier than the deterministic model for reasons unrelated to
// sequencing — keeping it standardized makes Normal vs. Historical an
// apples-to-apples comparison of shape alone, at whatever mean/volatility
// the user has actually set.
const _SP500_HIST_MEAN = _mean(SP500_ANNUAL_RETURNS);

const _SP500_HIST_STDEV = _stdevSample(SP500_ANNUAL_RETURNS);

const _SP500_STANDARDIZED = SP500_ANNUAL_RETURNS.map(r => (r - _SP500_HIST_MEAN) / _SP500_HIST_STDEV);

// Moving/circular block bootstrap: builds a `length`-long sequence of
// standardized historical shocks by repeatedly picking a random starting
// year in the historical series and taking `blockLen` CONSECUTIVE years
// from it (wrapping around to the start of the series if the block would
// run past the end, so every historical year — including ones near the end
// of the dataset — has an equal chance of starting a block). Consecutive
// real years preserve real autocorrelation and multi-year patterns (e.g.
// 2008-2009's crash-then-snapback, or the early-1930s multi-year slide) that
// resampling single years independently would destroy by shuffling them
// apart. blockLen=5 is a fixed, undramatic default in line with the
// block lengths commonly used for this in the retirement-planning
// literature; not exposed as a user setting in this pass. The final block
// is truncated if it would overshoot `length`.
function _blockBootstrapShocks(length, blockLen) {
  const n = _SP500_STANDARDIZED.length;
  const out = new Array(length);
  let i = 0;
  while (i < length) {
    const start = Math.floor(_rng() * n);
    for (let j = 0; j < blockLen && i < length; j++, i++) {
      out[i] = _SP500_STANDARDIZED[(start + j) % n];
    }
  }
  return out;
}

const _HIST_BOOTSTRAP_BLOCK_YEARS = 5;

// --- "Reverse Sequence Risk Test" (Retirement Income tab) -----------------
// A different lens on sequence-of-returns risk than the Monte Carlo engine
// above: not a probability distribution over many random iterations, but a
// single, deterministic, real historical stretch -- the same set of yearly
// shocks run forward, then run again in the exact reverse order -- to show
// concretely how much the ORDER of a specific bad stretch changes the
// outcome, holding the arithmetic average return (and the plan's own real
// inputs: account balances, withdrawal targets, DB pension, CPP/QPP+OAS
// start ages, province tax rules) completely fixed.
//
// Fixed default stretch: 1929, the single most severe run in the 100-year
// SP500_ANNUAL_RETURNS dataset above (1929: -8%, 1930: -25%, 1931: -43%,
// 1932: -8%) -- chosen over the other real candidates considered (the 1966
// stagflation grind, and the 2000 dot-com bust) as the single worst
// documented stretch; 1929 needs no wraparound for any realistic horizon
// length since it sits near the start of the dataset. Not exposed as a
// picker in this pass.
const SEQ_TEST_START_YEAR = 1929;

// Same standardized-z-score approach as the Historical bootstrap model
// above (see _SP500_STANDARDIZED's own comment): what's borrowed from 1929
// is the ORDER/SHAPE of its relative shocks, rescaled to whatever mean/
// stdev the caller supplies -- not 1929's literal raw percentages. That's
// what makes this "the plan's own actual risk under a real bad shape"
// rather than a generic textbook illustration with unrelated numbers.
// Wraps around cyclically past the end of the dataset (matching
// _blockBootstrapShocks' own convention above), so a horizon longer than
// the years remaining after the start year is never a problem -- though at
// 1929 this practically never triggers for any realistic retirement length.
function _seqTestZWindow(length, startYear) {
  const n = _SP500_STANDARDIZED.length;
  const startIdx = ((startYear - SP500_ANNUAL_RETURNS_START_YEAR) % n + n) % n;
  return Array.from({length}, (_, i) => _SP500_STANDARDIZED[(startIdx + i) % n]);
}

// Converts a sequence of standardized z-shocks into the {reg, nonreg}
// yearly-returns shape _runSim expects, using the exact same formula
// runMonteCarloSim uses for its own equity shocks (see that function's own
// comment for why non-reg is re-centered by nonregOffset rather than given
// an unrelated flat rate). Deliberately duplicated here rather than
// extracted into a function shared with runMonteCarloSim: that engine is a
// well-tested, load-bearing path (tests/12, tests/29) with its own blended-
// bond handling this test doesn't need, and keeping this simpler, separate
// copy means a future change to one can never accidentally regress the
// other.
function _zSequenceToYearlyReturns(zArr, mode, meanPct, stdevPct) {
  const meanReg = meanPct / 100, stdevReg = stdevPct / 100;
  const nonregFlat = (mode === 'resident') ? _SIM_GNREG : _SIM_GNREG_NONRES;
  const nonregOffset = _simG() - nonregFlat;
  const meanNonreg = meanReg - nonregOffset, stdevNonreg = stdevReg;
  return zArr.map(z => ({
    reg: meanReg + stdevReg * z,
    nonreg: meanNonreg + stdevNonreg * z,
  }));
}

// An "early market decline" sequence (N11, 2026-09-20): a flat drop for the
// first `dropYears` years, then the plan's own average for the rest. Built
// in the SAME {reg, nonreg} shape _zSequenceToYearlyReturns() produces --
// including its nonreg offset, so the Non-Reg account keeps its own lower
// flat return relative to the registered one -- because the point of this
// stress is the ORDER of returns, which a flat rate cannot express.
function _earlyDeclineReturns(nYears, mode, dropRate, dropYears) {
  const g = _simG();
  const nonregFlat = (mode === 'resident') ? _SIM_GNREG : _SIM_GNREG_NONRES;
  const nonregOffset = g - nonregFlat;
  const out = [];
  for (let i = 0; i < nYears; i++) {
    const reg = i < dropYears ? dropRate : g;
    out.push({ reg, nonreg: reg - nonregOffset });
  }
  return out;
}

// Every viability/success check in this app (Monte Carlo, Reverse Sequence
// Risk, the Sustainable Spend Scenario search, the deterministic
// Retirement Income tab, and the Compare tab's saved-scenario snapshot)
// answers the SAME question -- "did this plan actually fund every year's
// spending?" -- the same way, via two independent signals:
//  - _firstShortfallAge(rows): the real "did this fail" signal. Age of the
//    first row with an actual funding shortfall (row.shortfall, already
//    netted against every income source: DB, LIF, RRIF, QPP, OAS, TFSA,
//    Non-Reg, Emergency Fund), or null if every year was fully funded.
//    This is the ONLY thing "ran out"/"viable"/Monte Carlo "success" means
//    anywhere in this app.
//  - _portfolioDepletedAge(rows): a SEPARATE, purely informational signal --
//    age of the first row whose total account balance (LIF+RRIF/RRSP+TFSA+
//    Non-Reg+Emergency) reaches $0 by the END of that row's year (i.e. its
//    CLOSING balance, not what it opened the year with), or null if it
//    never does. Worth knowing (it means the plan is now leaning entirely
//    on guaranteed income), but never itself a failure -- a pension-only
//    retiree can perfectly normally draw LIF/RRIF/TFSA/Non-Reg/Emergency
//    down to $0 partway through retirement without that being a funding
//    failure, whenever guaranteed income (a DB pension, QPP/CPP, OAS)
//    fully covers spending on its own.
function _firstShortfallAge(rows) {
  if (!rows || !rows.length) return null;
  for (const r of rows) { if ((r.shortfall||0) > 0) return r.age; }
  return null;
}

// Checks each row's real CLOSING balance: for every row but the last,
// that's simply the NEXT row's opening balance (the same number, by
// construction -- one year's close is the next year's open); for the last
// row, every simulate* function already computes and stores it directly as
// *BalClose, so no row is ever skipped.
function _portfolioDepletedAge(rows) {
  if (!rows || !rows.length) return null;
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    const next = rows[y + 1];
    const bal = next
      ? (next.lifBal||0) + (next.rrspBal||0) + (next.tfsaBal||0) + (next.nonregBal||0) + (next.emergBal||0)
      : (r.lifBalClose||0) + (r.rrspBalClose||0) + (r.tfsaBalClose||0) + (r.nonregBalClose||0) + (r.emergBalClose||0);
    if (bal <= 0) return r.age;
  }
  return null;
}

// _taxCostBreakdown(rows) is the one shared, reconciled "total tax" for a
// plan's whole horizon, used by the age-summary badge's own total and the
// Compare tab's saved-scenario snapshot (_captureCurrentScenario()) instead
// of each summing its own ad hoc `row.tax`. Four real, unavoidable costs
// make up the total, each mutually exclusive by construction (confirmed in
// the simulate* functions: netInc already subtracts clawback separately
// from tax, and the cap-gains/div-int top-ups are drawn from TFSA/
// Emergency Fund, never added back into `tax`), so summing all four is a
// real total, not double-counting:
//  - row.tax: federal + provincial tax on taxable income.
//  - row.clawback: the OAS recovery tax (15% of net income above the
//    yearly threshold, capped at the OAS amount) -- always tracked as its
//    own field, completely separate from `tax` (see simulateResidentFixed:
//    `netInc = gross - tax - clawback`).
//  - the Realistic Non-Reg tax mode's capital-gains tax on a Non-Reg
//    withdrawal (computed inline in simulateResidentFixed, paid straight
//    out of TFSA/Emergency Fund the same year -- see the comment above that
//    computation). Non-Resident mode never has this cost (public-securities
//    exemption), so it's always exactly 0 there.
//  - nonregDivIntTax: under Realistic Non-Reg tax mode, _nonregTaxSplit()
//    computes real tax on that year's Non-Reg dividend/interest income
//    (`taxPaid`) and nets it out of the account's own growth before it
//    compounds (so the account BALANCE is always correct); this component
//    stores that same amount on the row so the total can reconcile it too.
//    Unlike capGainsTax, this one is NOT resident-only -- it applies to
//    Non-Resident mode too, just computed with withholding rates
//    (_nrDividendRate()/_nrInterestRate()) instead of graduated-bracket
//    tax.
function _taxCostBreakdown(rows) {
  if (!rows || !rows.length) return { tax: 0, clawback: 0, capGainsTax: 0, nonregDivIntTax: 0, total: 0 };
  const tax = Math.round(rows.reduce((s,r)=>s+(r.tax||0), 0));
  const clawback = Math.round(rows.reduce((s,r)=>s+(r.clawback||0), 0));
  const capGainsTax = Math.round(rows.reduce((s,r)=>s+(r.nonregCapGainsTax||0), 0));
  const nonregDivIntTax = Math.round(rows.reduce((s,r)=>s+(r.nonregDivIntTax||0), 0));
  return { tax, clawback, capGainsTax, nonregDivIntTax, total: tax + clawback + capGainsTax + nonregDivIntTax };
}

// runReverseSequenceTest({mode, ra, qppStart, oasStart, rawPort, meanPct,
// stdevPct}): runs the plan's real _runSim TWICE with the identical set of
// SEQ_TEST_START_YEAR-anchored standardized shocks -- once forward
// (chronological order, i.e. the crash lands EARLY in retirement, when the
// portfolio is largest and withdrawals are the biggest fraction of it), and
// once with that same set of shocks reversed (the crash lands LATE instead,
// after years of untouched compounding). Same arithmetic mean shock either
// way -- only the order differs -- so any difference between the two
// outcomes below is pure sequence-of-returns risk, not a different assumed
// return environment.
//
// Returns { horizon, startYear, meanPct, stdevPct, forward, reverse } where
// forward/reverse are each { rows, series, netEstate, ranOutAge, depletedAge }
// -- `series` is [{age, totalBal}, ...] for charting, `netEstate` reuses the
// exact same computeEstate() the Retirement Income tab's own Estate grid
// uses (so these numbers are directly comparable to what that grid shows --
// note computeEstate() itself reads the global spendMode for resident-vs-
// non-resident tax treatment, so as with every other caller, `mode` here
// should match the current spendMode); `ranOutAge` and `depletedAge` are
// _firstShortfallAge()/_portfolioDepletedAge() on this run's own rows -- see
// those functions' header comment for why they're two separate signals.
//
// Does not read or write liveData/currentAge/any other rendering global --
// safe to call speculatively without side effects, same guarantee
// runMonteCarloSim makes.
function runReverseSequenceTest({mode, ra, qppStart, oasStart, rawPort, meanPct, stdevPct}) {
  const probeRows = _runSim(mode, ra, qppStart, oasStart, rawPort);
  const horizon = probeRows.length;
  if (!horizon) return { horizon: 0, startYear: SEQ_TEST_START_YEAR, meanPct, stdevPct, forward: null, reverse: null };

  const zForward = _seqTestZWindow(horizon, SEQ_TEST_START_YEAR);
  const zReverse = zForward.slice().reverse();

  function runOne(zArr) {
    const yearlyReturns = _zSequenceToYearlyReturns(zArr, mode, meanPct, stdevPct);
    const rows = _runSim(mode, ra, qppStart, oasStart, rawPort, yearlyReturns);
    const series = rows.map(r => ({
      age: r.age,
      totalBal: (r.lifBal||0) + (r.rrspBal||0) + (r.tfsaBal||0) + (r.nonregBal||0) + (r.emergBal||0),
    }));
    return { rows, series, netEstate: computeEstate(rows).net, ranOutAge: _firstShortfallAge(rows), depletedAge: _portfolioDepletedAge(rows) };
  }

  return {
    horizon, startYear: SEQ_TEST_START_YEAR, meanPct, stdevPct,
    forward: runOne(zForward),
    reverse: runOne(zReverse),
  };
}

// --- Sustainable Spend Scenario search -------------------------------------
// Finds the largest sustainSpendScale (see its declaration for the full
// overlay rationale) that still passes BOTH: (1) the deterministic
// simulation, fully funded through the whole horizon, and (2)
// runReverseSequenceTest() above, fully funded in BOTH the forward and
// Scales overall Budget spending (not the Target Income table -- that
// doesn't drive viability, see _budgetAnnualNom()'s header comment);
// viability = deterministic + Reverse Sequence Risk Test, not Monte Carlo
// (RSR is a single fixed sequence, cheap enough to re-check at every step
// of a search; Monte Carlo's hundreds of randomized trials per check would
// not be); surfaced as a toggleable what-if overlay, not a destructive
// rewrite of your real Budget-tab numbers.
const SUSTAIN_SCALE_MIN = 0.10, SUSTAIN_SCALE_MAX = 3.00;

// Go-Go/Slow-Go/No-Go spending shape (JP, 2026-09-15): a second search mode
// alongside the flat uniform one above. Instead of scaling every retirement
// year by the same factor, 'phased' mode applies ONE found scale through a
// declining 3-phase shape -- full Budget-tab spending in the active Go-Go
// years, tapering down through Slow-Go and No-Go -- so "the highest overall
// level" reflects the widely-observed pattern of real retirement spending
// easing off with age/activity, not a flat line. Same phase boundaries as
// the Go-Go/Slow-Go/No-Go summary cards on the Retirement Income tab (see
// renderAll()'s own phase-card block, which now reads these same two
// constants instead of re-declaring the ages locally) -- age
// retirement-74 / 75-84 / 85+.
//
// Ratios are a fixed, deliberately simple illustrative shape, not sourced
// to one specific published study (real research on retirement spending
// decline varies by dataset/cohort, and some studies show a late-life
// uptick from healthcare/long-term-care costs that this simple shape does
// NOT model) -- chosen to be directionally consistent with that broad body
// of research: full spending while active, tapering as activity/travel
// spending naturally drops off. Go-Go's ratio is deliberately 1.00 so a
// phased-mode scale of 100% means exactly "your current Budget-tab numbers,
// unreduced, during the Go-Go years" -- the same intuitive reference point
// uniform mode's scale already uses, just no longer flat across every year.
// Not user-editable (JP, 2026-09-15): keeps this a one-variable search,
// exactly like uniform mode.
const RETIREMENT_PHASE_GOGO_END = 74, RETIREMENT_PHASE_SLOWGO_END = 84;
const SUSTAIN_PHASE_SHAPE = { gogo: 1.00, slowgo: 0.85, nogo: 0.70 };
function _sustainPhaseRatio(age) {
  if (age <= RETIREMENT_PHASE_GOGO_END) return SUSTAIN_PHASE_SHAPE.gogo;
  if (age <= RETIREMENT_PHASE_SLOWGO_END) return SUSTAIN_PHASE_SHAPE.slowgo;
  return SUSTAIN_PHASE_SHAPE.nogo;
}
// The effective per-age Sustainable Spend Scenario scale -- 1 (no-op) while
// inactive; the flat sustainSpendScale in 'uniform' mode (byte-identical to
// this feature's original single-mode behavior); the same scale shaped
// through _sustainPhaseRatio(age) in 'phased' mode. Both real call sites
// (_emergencyFundAnnualNom() below, _budgetTotalsAtAge() in the main
// script) already take `age`, so this is a drop-in replacement for the flat
// `sustainSpendActive ? sustainSpendScale : 1` expression both used before
// phased mode existed.
function _effectiveSustainScale(age) {
  if (!sustainSpendActive) return 1;
  return sustainSpendMode === 'phased' ? sustainSpendScale * _sustainPhaseRatio(age) : sustainSpendScale;
}

// "Fully funded" means exactly _firstShortfallAge(rows) == null -- see that
// function's header comment. A scale is never disqualified just because
// the total portfolio hits $0 before the last simulated year with zero
// real shortfall -- that's a pension-only retirement's normal, by-design
// account drawdown, not a viability failure. Portfolio depletion is still
// surfaced to the user (see runSustainSpendSearch()'s own use of
// _portfolioDepletedAge()), just never as a reason to fail viability here.
function _sustainRowsFullyFunded(rows) {
  if (!rows || !rows.length) return false; // no data to confirm viability -- fail safe, not vacuously true
  return _firstShortfallAge(rows) == null;
}

// Checks one candidate scale. Temporarily flips the SAME global overlay
// state the real toggle uses (so this is exercising the exact code path a
// user would actually get, not a parallel simulation), always restored in
// a `finally` -- side-effect-free from the caller's perspective, same
// guarantee runReverseSequenceTest() itself makes.
function _sustainIsViable(scale, ctx) {
  const prevActive = sustainSpendActive, prevScale = sustainSpendScale, prevMode = sustainSpendMode;
  sustainSpendActive = true;
  sustainSpendScale = scale;
  sustainSpendMode = ctx.searchMode === 'phased' ? 'phased' : 'uniform';
  try {
    const rows = _runSim(ctx.mode, ctx.ra, ctx.qppStart, ctx.oasStart, ctx.rawPort);
    if (!_sustainRowsFullyFunded(rows)) return false;
    const rsr = runReverseSequenceTest({
      mode: ctx.mode, ra: ctx.ra, qppStart: ctx.qppStart, oasStart: ctx.oasStart,
      rawPort: ctx.rawPort, meanPct: ctx.meanPct, stdevPct: ctx.stdevPct,
    });
    return !!(rsr.forward && rsr.reverse && rsr.forward.ranOutAge == null && rsr.reverse.ranOutAge == null);
  } finally {
    sustainSpendActive = prevActive;
    sustainSpendScale = prevScale;
    sustainSpendMode = prevMode;
  }
}

// Runs one simulation at the given scale (temporarily flipping the overlay
// on, same temp-flip/restore pattern as _sustainIsViable() above) and
// returns its rows + Net Estate -- used by runSustainSpendSearch() to show
// a Net Estate comparison for the found rate without permanently activating
// the overlay. Uses the CURRENT live combo (spendMode/currentAge/qppStart/
// oasStart/liveData.rawPort), same as _findSustainableSpendScale()'s own ctx.
function _sustainPreviewAtScale(scale, mode) {
  if (!liveData || !liveData.rawPort) return null;
  const prevActive = sustainSpendActive, prevScale = sustainSpendScale, prevMode = sustainSpendMode;
  sustainSpendActive = true;
  sustainSpendScale = scale;
  sustainSpendMode = mode === 'phased' ? 'phased' : 'uniform';
  try {
    const rows = _runSim(spendMode, currentAge, qppStart, oasStart, liveData.rawPort);
    return { rows, netEstate: (rows && rows.length) ? computeEstate(rows).net : null };
  } finally {
    sustainSpendActive = prevActive;
    sustainSpendScale = prevScale;
    sustainSpendMode = prevMode;
  }
}

// --- Canadian bond assumption for the "Blended" Monte Carlo option --------
// Real year-by-year Canadian bond TOTAL RETURN history isn't published
// anywhere as a clean series the way US equity history is above: taxtips.ca
// (the same source already used elsewhere in this file for tax figures)
// publishes only multi-period compound averages -- 1/5/10/20/46/50/76-year
// windows -- not individual years, so unlike the S&P 500 series there's no
// real bond SEQUENCE to resample here. The mean uses the long-run
// historical average (taxtips.ca's Canada long-bond series is a remarkably
// stable 6.1%/6.4%/6.1% across the 46/50/76-year windows it publishes, vs.
// a forward-looking, much-lower current-yield estimate), paired with PWL
// Capital's published volatility estimate (5.36% -- the only credible
// standard-deviation figure found; taxtips.ca doesn't publish one). Drawn
// INDEPENDENTLY each year in runMonteCarloSim below, rather than
// resampled/sequenced the way the equity portion is (there's no real
// historical sequence to draw from) -- so this is a real-equity-shape-plus-
// parametric-bond hybrid, not a true blended-portfolio historical backtest.
// 2026-09-17 (review A8): the 6.1% historical mean made every Blended run
// systematically rosier than the user's own return assumption (0.6 x 3.5 +
// 0.4 x 6.1 = 4.54% vs 3.5% in the other two models -- a mean effect, not a
// diversification effect). The sleeve's mean is now an input on the Monte
// Carlo controls ("Bond mean"), defaulting to CANADA_BOND_MEAN_DEFAULT --
// the current long-bond yield the file already uses elsewhere (~3.5%) --
// with the historical figure kept for the reference line. Volatility is
// unchanged.
const CANADA_BOND_MEAN_HISTORICAL = 0.061;
const CANADA_BOND_MEAN_DEFAULT = 0.035;

// ── Mortality / probability-weighted horizon (2026-09-17, review C10) ───
// Approximate annual probabilities of death (qx) at five-year ages, read
// from Statistics Canada's 2020-2022 life tables (table 13-10-0114-01) and
// rounded; ages in between are interpolated log-linearly (mortality rises
// roughly exponentially with age -- Gompertz -- so a straight line in
// log(qx) is the natural fit). "Unisex" is the plain average of the two.
// Used for two things only: the "P(alive)" figure shown beside the
// horizon age (chance of still being alive at the "predict until age",
// given you are alive at today's age), and the mortality-weighted Monte
// Carlo failure rate (a shortfall only counts if it happens while you are
// alive). Nothing in the deterministic plan is changed by these numbers.
const MORTALITY_QX = {
  ages: [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110],
  m:    [0.0032, 0.0050, 0.0078, 0.0120, 0.0180, 0.0290, 0.0480, 0.0830, 0.1420, 0.2200, 0.3200, 0.4200, 0.5000],
  f:    [0.0020, 0.0031, 0.0048, 0.0076, 0.0115, 0.0190, 0.0330, 0.0610, 0.1120, 0.1900, 0.2900, 0.4000, 0.5000],
};
var _mortalityTable = 'u'; // 'u' unisex (average), 'm' male, 'f' female -- the main file syncs this from profile.mortality
function _mortalityQx(age, table) {
  table = table || _mortalityTable;
  const A = MORTALITY_QX.ages;
  const col = k => MORTALITY_QX[k];
  const pick = (k, i) => col(k)[i];
  const at = i => table === 'm' ? pick('m', i) : table === 'f' ? pick('f', i) : (pick('m', i) + pick('f', i)) / 2;
  if (age <= A[0]) { // below 50: extrapolate the 50-55 slope downward, floored at a small background rate
    const slope = Math.log(at(1) / at(0)) / (A[1] - A[0]);
    return Math.max(0.0005, at(0) * Math.exp(slope * (age - A[0])));
  }
  if (age >= A[A.length - 1]) return Math.min(1, at(A.length - 1));
  let i = 0;
  while (age >= A[i + 1]) i++;
  const f = (age - A[i]) / (A[i + 1] - A[i]);
  return Math.exp(Math.log(at(i)) * (1 - f) + Math.log(at(i + 1)) * f);
}
// P(alive at toAge | alive at fromAge). Each year's survival is (1 - qx).
function _survivalProb(fromAge, toAge, table) {
  let p = 1;
  for (let a = fromAge; a < toAge; a++) p *= 1 - _mortalityQx(a, table);
  return p;
}
// Remaining life expectancy from `fromAge`, as the AGE it points to
// (curtate expectation + half a year), e.g. 65 -> ~85 unisex.
function _lifeExpectancyAge(fromAge, table) {
  let e = 0, p = 1;
  for (let a = fromAge; a < 115 && p > 1e-6; a++) { p *= 1 - _mortalityQx(a, table); e += p; }
  return fromAge + e + 0.5;
}

const CANADA_BOND_STDEV = 0.0536;

// percentile(arr, p): p in [0,100]. Linear interpolation between the two
// nearest ranks, same convention Excel's PERCENTILE.INC uses. arr is copied
// and sorted internally, so the caller's array is never mutated.
function _percentile(arr, p) {
  if (!arr || !arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// runMonteCarloSim({mode, ra, qppStart, oasStart, rawPort, meanPct, stdevPct,
// iterations, returnModel, equityWeightPct}):
// Runs `iterations` independent simulations of the given mode/portfolio, each
// year drawing ONE shared market shock z that's applied (with a correlation
// of 1, i.e. the same shock) to both the registered and non-reg rates for
// that simulated year -- registered accounts move with meanPct/stdevPct
// directly, non-reg accounts move at the same shock but centered
// nonregOffset lower, preserving today's existing flat-rate gap between
// registered and non-reg growth (2.5%/3.0% vs whatever the registered mean
// is) rather than introducing a new, unrelated assumption.
//
// returnModel picks how each year's z is drawn: 'normal' (default) draws an
// independent z~Normal(0,1) every year, same as before this option existed.
// 'historical' instead draws z-sequences via _blockBootstrapShocks -- real,
// standardized S&P 500 annual shocks resampled in 5-year historical blocks,
// so autocorrelation and real crash/recovery sequences (not just a random
// year-by-year shuffle) show up in the simulated paths. 'blended' reuses that
// SAME real equity resampling for an "equity sleeve" (rescaled to
// meanPct/stdevPct exactly like 'historical'), then blends in a "bond
// sleeve" weighted by equityWeightPct (default 60% equity/40% bonds) --
// see CANADA_BOND_MEAN/CANADA_BOND_STDEV's comment above for why the bond
// sleeve is an independently-drawn Normal rather than a real resampled
// sequence (no clean year-by-year Canadian bond history exists to resample).
// Omitting returnModel, or passing anything other than 'historical'/
// 'blended', is byte-for-byte identical to the original Normal-only
// behavior.
//
// Returns {iterations, successRate, depletionRate, bands, meanReg, stdevReg,
// meanNonreg, stdevNonreg, returnModel, histMeanPct, histStdevPct,
// equityWeightPct} where bands is [{age, p10, p50, p90}, ...] of TOTAL
// portfolio balance (lif+rrif/rrsp+tfsa+nonreg+emerg) at each simulated age.
// successRate is the fraction of iterations with NO real funding shortfall
// in any year (_firstShortfallAge(rows) == null on that iteration's own
// rows -- see that function's header comment for why this is the ONLY
// thing "success" means here). depletionRate is
// a SEPARATE, purely informational fraction: how many iterations had their
// total portfolio balance reach $0 before the last simulated year
// (_portfolioDepletedAge(rows) != null on that same iteration), REGARDLESS
// of whether that iteration also succeeded -- a run can deplete its
// portfolio and still be a success, if guaranteed income (DB/QPP/OAS) kept
// covering spending the whole time. histMeanPct/histStdevPct are the S&P
// 500 dataset's own real historical mean/stdev (in %, always returned
// regardless of returnModel) purely for UI reference -- they never affect
// the simulation itself, since the historical shocks are standardized (see
// _SP500_STANDARDIZED's comment above). equityWeightPct echoes back whatever
// was used (60 when omitted), for UI reference only -- it's a no-op unless
// returnModel is 'blended'.
//
// Does not read or write liveData/currentAge/any other rendering global --
// safe to call speculatively without side effects.
function runMonteCarloSim({mode, ra, qppStart, oasStart, rawPort, meanPct, stdevPct, iterations, returnModel, equityWeightPct, bondMeanPct, mortalityFromAge, mortalityTable}) {
  iterations = iterations || 1000;
  returnModel = (returnModel === 'historical' || returnModel === 'blended') ? returnModel : 'normal';
  const equityWeight = Math.max(0, Math.min(100, equityWeightPct != null ? equityWeightPct : 60)) / 100;
  const bondMean = Number.isFinite(bondMeanPct) ? bondMeanPct / 100 : CANADA_BOND_MEAN_DEFAULT; // A8: user input, default = current yield
  const meanReg = meanPct / 100;
  const stdevReg = stdevPct / 100;
  // Preserve today's existing gap between the flat registered rate and the
  // flat non-reg rate, so a Monte Carlo run at the SAME mean as today's
  // deterministic growth rate reproduces today's non-reg behavior too.
  const nonregFlat = (mode === 'resident') ? _SIM_GNREG : _SIM_GNREG_NONRES;
  const nonregOffset = _simG() - nonregFlat;
  const meanNonreg = meanReg - nonregOffset;
  const stdevNonreg = stdevReg; // same shock, same spread, just re-centered

  // Horizon length varies by mode/age/the "predict until age X" setting the
  // same way the deterministic sims do (age..#simEndAge inclusive) --
  // determine it once from a throwaway flat-rate run so every iteration's
  // yearlyReturns array is exactly long enough.
  const probeRows = _runSim(mode, ra, qppStart, oasStart, rawPort);
  const horizon = probeRows.length;
  const histMeanPct = _SP500_HIST_MEAN * 100, histStdevPct = _SP500_HIST_STDEV * 100;
  if (!horizon) return { iterations: 0, successRate: 0, depletionRate: 0, bands: [], meanReg, stdevReg, meanNonreg, stdevNonreg, returnModel, histMeanPct, histStdevPct, equityWeightPct: equityWeight * 100 };

  const balancesByYear = Array.from({length: horizon}, () => []);
  let successCount = 0, depletionCount = 0;
  // C10: mortality weighting. A shortfall at age X only matters with
  // probability P(alive at X | alive today); summed over iterations this
  // gives the chance of a shortfall in your lifetime, which is what the
  // plain success rate overstates when the horizon runs well past life
  // expectancy. `mortalityFromAge` is today's age (the main file passes
  // _personAge()); it defaults to the Start Age when a caller omits it.
  const mortFrom = Number.isFinite(mortalityFromAge) ? mortalityFromAge : ra;
  const mortTable = mortalityTable || _mortalityTable;
  let aliveAtShortfall = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const shocks = (returnModel === 'historical' || returnModel === 'blended')
      ? _blockBootstrapShocks(horizon, _HIST_BOOTSTRAP_BLOCK_YEARS)
      : Array.from({length: horizon}, () => _randNormal(0, 1));
    const yearlyReturns = new Array(horizon);
    for (let y = 0; y < horizon; y++) {
      const z = shocks[y];
      const equityReg = meanReg + stdevReg * z, equityNonreg = meanNonreg + stdevNonreg * z;
      if (returnModel === 'blended') {
        // Bond sleeve: one independent draw per year (NOT the same z as the
        // equity shock -- see the comment on runMonteCarloSim above for why
        // there's no real bond sequence to correlate it to), applied at the
        // same weight to both the registered and non-reg rates since it's
        // the same year's bond market either way, just a different account
        // wrapper.
        const bond = _randNormal(bondMean, CANADA_BOND_STDEV);
        yearlyReturns[y] = {
          reg: equityWeight * equityReg + (1 - equityWeight) * bond,
          nonreg: equityWeight * equityNonreg + (1 - equityWeight) * bond,
        };
      } else {
        yearlyReturns[y] = { reg: equityReg, nonreg: equityNonreg };
      }
    }
    const rows = _runSim(mode, ra, qppStart, oasStart, rawPort, yearlyReturns);
    for (let y = 0; y < rows.length; y++) {
      const r = rows[y];
      const totalBal = (r.lifBal||0) + (r.rrspBal||0) + (r.tfsaBal||0) + (r.nonregBal||0) + (r.emergBal||0);
      balancesByYear[y].push(totalBal);
    }
    // Success and depletion are two independent questions -- see
    // _firstShortfallAge()/_portfolioDepletedAge()'s shared header comment
    // above. A run that grinds its portfolio to $0 but never actually
    // falls short of the spending target (guaranteed income covered it) is
    // still a success.
    const shortfallAge = _firstShortfallAge(rows);
    if (shortfallAge == null) successCount++;
    else aliveAtShortfall += _survivalProb(mortFrom, shortfallAge, mortTable);
    if (_portfolioDepletedAge(rows) != null) depletionCount++;
  }
  const lastAge = probeRows[probeRows.length - 1].age;

  const bands = probeRows.map((r, y) => ({
    age: r.age,
    p10: Math.round(_percentile(balancesByYear[y], 10)),
    p50: Math.round(_percentile(balancesByYear[y], 50)),
    p90: Math.round(_percentile(balancesByYear[y], 90)),
  }));

  return {
    iterations,
    successRate: successCount / iterations,
    depletionRate: depletionCount / iterations,
    bands,
    meanReg, stdevReg, meanNonreg, stdevNonreg,
    returnModel, histMeanPct, histStdevPct,
    equityWeightPct: equityWeight * 100,
    bondMeanPct: bondMean * 100,
    // C10 (2026-09-17): P(shortfall while alive), P(alive at the horizon
    // age) and the life table used, all from mortalityFromAge.
    mortalityFailRate: aliveAtShortfall / iterations,
    survivalToHorizon: _survivalProb(mortFrom, lastAge, mortTable),
    lifeExpectancyAge: _lifeExpectancyAge(mortFrom, mortTable),
    mortalityFromAge: mortFrom,
    mortalityTable: mortTable,
    horizonAge: lastAge,
  };
}

// Sanity/invariant checks on a simulation's row output. Purely diagnostic —
// this never alters any number, it only decides whether to show a warning
// banner (#simSanityWarning) instead of silently displaying a plausible-
// looking but wrong figure. Added after the rerunRetirement() cold-start bug
// and an earlier no-double-shovel bug turned out to be the same failure
// shape: a normal-looking number that was quietly incorrect.
function _validateSimRows(rows) {
  const issues = [];
  if (!rows || !rows.length) return issues;
  const BAL_FIELDS = ['lifBal','rrspBal','tfsaBal','nonregBal','emergBal'];
  const NUM_FIELDS = ['totalTaxable','tax','totalSpend','qpp','oas'].concat(BAL_FIELDS);
  let sawNaN = false, sawNegative = false;
  for (const r of rows) {
    for (const f of NUM_FIELDS) {
      const v = r[f];
      if (v == null) continue; // not every field is present on every row shape
      if (typeof v !== 'number' || Number.isNaN(v)) sawNaN = true;
    }
    for (const f of BAL_FIELDS) {
      const v = r[f];
      if (typeof v === 'number' && v < -1) sawNegative = true; // $1 rounding slack
    }
  }
  if (sawNaN) issues.push(t('ret.sanity.nan'));
  if (sawNegative) issues.push(t('ret.sanity.negative'));
  // "Budget looks unset" — every row is a live simulation (the precomputed
  // reference tables, which always had a real spend figure baked in, are
  // gone), so this check always applies. A
  // live sim with a substantial starting portfolio but ~$0 actual spend
  // (totalSpend, the amount actually drawn against the Budget tab's total —
  // not spendTarget, which tracks the separate "Target Income" bands above)
  // usually means the Budget tab hasn't been filled in yet, not that $0/yr
  // is the real plan.
  const firstRow = rows[0];
  const startingBal = (firstRow.lifBal||0)+(firstRow.rrspBal||0)+(firstRow.tfsaBal||0)+(firstRow.nonregBal||0);
  const nearZeroSpend = rows.every(r => (r.totalSpend||0) < 100);
  if (startingBal > 10000 && nearZeroSpend) {
    issues.push(t('ret.sanity.zeroSpend'));
  }
  return issues;
}

function runLiveSim(ra, lif, rrsp, tfsa, nonreg=0, tfsaRoom=null, rrspRoom=null) {
  // Full grid over both continuous start-age sliders (QPP 65-72, OAS 65-70
  // — 8 x 6 = 48 combos), precomputed for both residency modes up front so
  // dragging either slider is still an instant cache lookup. Each
  // combo is one cheap year-by-year arithmetic pass (no Monte Carlo), so
  // even the full 96 calls (Quebec's 8 QPP ages) stays fast — CPP provinces
  // only need 6 QPP ages (65-70, same ceiling as OAS), so their grid is
  // smaller still.
  const combos=[];
  const qppMaxStart=_qppMaxStart();
  for(let qpp=QPP_MIN_START;qpp<=qppMaxStart;qpp++){
    for(let oas=OAS_MIN_START;oas<=OAS_MAX_START;oas++){
      combos.push({qpp,oas});
    }
  }
  const rawPort={lif,rrsp,tfsa,nonreg,tfsaRoom,rrspRoom};
  const port=_applyHalfUnlock(rawPort); // Resident-only transform, used for display purposes
  const d={resident:{},nonresident:{}};
  for(const {qpp,oas} of combos){
    const key=`${qpp}_${oas}`;
    d.resident[key]=_runSim('resident',ra,qpp,oas,rawPort);
    d.nonresident[key]=_runSim('nonresident',ra,qpp,oas,rawPort);
  }
  liveData={ra,data:d,port,rawPort};
}

// ═══════════════════════════════════════════════════════════════════════════
// Household / spouse model (2026-09-17, review section C item 4 / step 5e)
// ═══════════════════════════════════════════════════════════════════════════
// A second person is modelled as a SECOND, INDEPENDENT engine run -- the
// same simulateResidentFixed() the primary plan uses, driven by the spouse's
// own inputs -- followed by a per-calendar-year household merge. Nothing in
// the three simulate* functions changed for this.
//
// How the engine gets a person's inputs (2026-09-19, review close-out):
// every input the engine reads through a global -- the DB pension, the
// Target curve, the RRIF/TFSA/rate overrides, the assets, the unlock /
// meltdown / emergency-fund flags, the Budget functions, the budget share
// and the engine-settings override -- is one field of a PERSON-INPUTS
// object. _primaryPersonInputs() reads the live plan's; _spousePersonInputs()
// builds the spouse's from the Profile tab's household fields; and
// simulateResidentFixed(..., inputs) / _withPersonInputs(inputs, fn) are the
// ONLY places that install an inputs object into the globals (and restore
// the previous one in a finally block). Until this close-out runSpouseSim()
// swapped each global by hand, so every household fix (second review H1
// and H2) was about a global that had leaked; now a run cannot read one
// person's DB pension with the other person's Target curve, because they
// travel together in one object, and a new engine global has exactly one
// place to be added (PERSON_INPUT_KEYS below).
//
// What the merge does, and does not, model:
//   * Each person funds their SHARE of the household Budget (Profile ->
//     Household -> "share of the household budget"); the primary's run funds
//     100% - share. Each run's gap-fill, minimums, surplus deposits and
//     shortfalls are therefore per person, then summed.
//   * Pension income splitting (ITA s.60.03 / TP-1 Schedule Q): each year
//     both are retired, up to 50% of the higher earner's eligible pension
//     income (DB at any age; RRIF/LIF from 65) is notionally moved to the
//     lower earner and both returns are recomputed with the app's own
//     _calcTaxDetail(), keeping whichever transfer minimises federal +
//     provincial tax + OAS clawback for the couple. Quebec follows its own
//     rule that the transferor must be 65+ for the provincial split (since
//     2014), so under 65 only the federal return splits. The recipient gets
//     the pension credit on the split amount only if 65+ (the common case).
//   * OAS clawback is per person, on each person's own (post-split) income.
//   * Survivor: each person's plan ends at the same "predict until age" in
//     their own age. When the first person's horizon is reached, the
//     survivor keeps a survivor DB pension (a percentage of the deceased's
//     last DB amount, flat) and inherits the deceased's closing balances --
//     TFSA and cash tax-free, registered accounts tax-deferred, Non-Reg with
//     its ACB -- which grow at the retirement growth rate and are counted
//     (after the usual death tax) in the household estate at the survivor's
//     own horizon.
//   * Cash-flow sharing (2026-09-19, N4; opts.shareEnabled, on by default;
//     the Profile card's "Share cash flow" box). The two runs stay
//     precomputed; the merge then lets household money move between them,
//     in this order, only where a person's OWN run shows a funding
//     shortfall (its accounts already empty):
//       1. the other person's same-year surplus (what their run deposited
//          that year) covers it. The gift is then fed back into BOTH runs
//          as an external cash flow (see _externalFlows / row.externalFlow)
//          and both are re-simulated, so the giver really has less from
//          then on and the receiver really has the money -- the merge
//          repeats (find gifts -> re-simulate -> find gifts) until no new
//          gift appears, at most 8 passes. Requires opts.rerun = { p(flows),
//          s(flows) } from the caller; without it this step is skipped (it
//          could not be done honestly post hoc: 2026-09-19 external review
//          -- the same dollar funded both partners);
//       2. the pension-splitting saving is reinvested in a household pool
//          (grows at the retirement growth rate, no tax modelled on it)
//          which covers what is left; whatever remains in the pool at the
//          end joins the estate;
//       3. after the first death, the survivor draws on the inheritance --
//          TFSA and cash first (tax-free), then Non-Reg (the gain fraction
//          taxed at half the survivor's marginal rate), then the registered
//          balance (grossed up so the net draw covers the shortfall, the tax
//          added to the survivor's year).
//     A shortfall that survives all three is the household shortfall.
//     Steps 2 and 3 move money that is in neither run (the tax saving is
//     never in the engine; the inheritance is the deceased's closing
//     balances), so they need no re-simulation.
//   * A person who has not retired yet in a given year contributes nothing
//     to the household figures for that year (employment income isn't
//     modelled for a spouse); the year is marked "not yet retired".
//   * Resident mode only. Non-Resident plans keep the single-person model.
// Everything is nominal; the display layer applies the today's-$ toggle by
// the PRIMARY's age for the calendar year (both are the same year).

// The primary plan's live engine settings, read with every override
// cleared -- the spouse run starts from these and replaces only the
// person-specific keys.
function _liveEngineSettings() {
  const saved = _engineSettingsOverride;
  _engineSettingsOverride = null;
  try {
    return {
      cpiRate: _cpiRate(), personAge: _personAge(), currentProvince: _currentProvince(),
      oasYearsRequired: _oasYearsRequired(), qppEligible: _qppEligible(), oasEligible: _oasEligible(), oasQualifyingYears: _oasQualifyingYears(),
      nrPensionRate: _nrPensionRate(), nrDividendRate: _nrDividendRate(), nrInterestRate: _nrInterestRate(),
      dbCola: _dbCola(), dbFreeze: _dbFreeze(), dbBridgeAmount: _dbBridgeAmount(), dbBridgeEndAge: _dbBridgeEndAge(),
      federallyRegulated: _federallyRegulated(), qppBase65: _qppBase65(), simG: _simG(), dbPensionAdjustmentAnnual: _dbPensionAdjustmentAnnual(),
      nonregPretaxReturn: _nonregPretaxReturn(), nonregStartGainFrac: _nonregStartGainFrac(), nonregMix: _nonregMix(),
      healthLevies: _healthLeviesEnabled(),
    };
  } finally { _engineSettingsOverride = saved; }
}

// Grows the spouse's balances as of today to their retirement age: each
// account compounds at the retirement growth rate (Non-Reg at the Non-Reg
// rate) with the stated annual contribution added at each year end.
function _spouseOpeningPortfolio(sp, g, gNonreg) {
  const years = Math.max(0, sp.retAge - sp.curAge);
  const grow = (bal, annual, rate) => { let b = bal || 0; for (let i = 0; i < years; i++) b = b * (1 + rate) + (annual || 0); return Math.round(b); };
  return {
    lif: grow(sp.lif, 0, g), rrsp: grow(sp.rrsp, sp.rrspAnnual, g), tfsa: grow(sp.tfsa, sp.tfsaAnnual, g), nonreg: grow(sp.nonreg, 0, gNonreg),
    tfsaRoom: null, rrspRoom: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Calculation-rules register (2026-09-19, N6)
// ═══════════════════════════════════════════════════════════════════════════
// Every year-pinned or sourced constant the engine uses, in one dated list:
// which tax/benefit year it belongs to, where it came from, when it was
// last checked against that source, and what approximation remains. The
// Help tab renders it live (the `value` functions read the constants
// themselves, so the register can never disagree with the engine), the
// plan check compares RULES_YEAR with the plan's calendar year, and
// tools/rules-register.js writes RULES_REGISTER.md from it for the repo.
// Maintenance: every January, re-check each row against its source, update
// the constant, and bump `checked` (and RULES_YEAR once every row is on the
// new year). A row whose `checked` is older than the others is the one to
// look at first.
const RULES_YEAR = 2026;
const RULES_REGISTER = [
  // ---- survivor benefits (N10, 2026-09-20) ----
  { id: 'survivorPension', group: 'benefits', name: 'CPP/QPP survivor\'s pension', year: 2025, symbol: 'SURVIVOR_PCT_65PLUS / CPP_SURVIVOR_UNDER65_PCT / CPP_SURVIVOR_FLAT_ANNUAL / QPP_SURVIVOR_FLAT_ANNUAL',
    value: () => `65+: ${(SURVIVOR_PCT_65PLUS*100).toFixed(0)}% of the deceased's pension · under 65: ${_fmtRegisterMoney(_currentProvince()==='quebec' ? QPP_SURVIVOR_FLAT_ANNUAL : CPP_SURVIVOR_FLAT_ANNUAL)}/yr flat + ${(CPP_SURVIVOR_UNDER65_PCT*100).toFixed(1)}% · combined cap = one maximum retirement pension`,
    source: 'Service Canada — CPP survivor\'s pension; Retraite Québec — QPP surviving spouse\'s pension', url: 'https://www.canada.ca/en/services/benefits/publicpensions/cpp/cpp-survivor-pension.html',
    checked: '2026-09-20', note: 'Computed from the deceased\'s retirement pension AS IF THEY HAD BEEN 65 at death ("We first calculate the amount that the CPP retirement pension of the deceased is, or would have been, if the deceased had been age 65 at the time of death"), not from what they were actually being paid -- so a deferral increase does not raise it and a contributor who died before starting still leaves one. Corrected 2026-09-20; before that the deceased\'s last projected payment was used as the base. The two flat-rate amounts are still 2025 published figures carried into 2026: the 2026-09-20 register pass could not reach Service Canada\'s CPP payment-amounts table (its own links returned 404), so they are recorded as unverified on that date rather than silently re-dated. they are then indexed forward with the same conservative rate the retirement pension uses. The combined cap is modelled against one maximum retirement pension, which is the rule for a survivor aged 65+; the under-65 cap in the real plans is computed slightly differently.' },
  { id: 'oasAllowanceSurvivor', group: 'benefits', name: 'OAS Allowance for the Survivor (60-64)', year: 2026, symbol: 'OAS_ALW_SURVIVOR_MAX_ANNUAL / OAS_ALW_SURVIVOR_CUTOFF',
    value: () => `max ${_fmtRegisterMoney(OAS_ALW_SURVIVOR_MAX_ANNUAL)}/yr · nil at ${_fmtRegisterMoney(OAS_ALW_SURVIVOR_CUTOFF)} of income`,
    source: 'Service Canada — Allowance for the Survivor, benefit amount', url: 'https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/guaranteed-income-supplement/allowance-survivor/benefit-amount.html',
    checked: '2026-09-20', note: 'TAX-FREE ("a monthly tax-free payment"): counted as available cash and never added to taxable income. Corrected 2026-09-20; before that it was taxed. Paid only from 60 to 64, to a survivor who has not remarried. Both figures re-checked against Service Canada on 2026-09-20 and updated to the July-September 2026 quarter: the maximum was 2025\'s $1,647.34/month and the cutoff 2025\'s $29,712, carried forward unindexed, which understated the benefit by about $660/yr and cut it off about $1,000 of income too early. The real benefit follows a published income table; this models it as a straight-line phase-out from the maximum to zero across the income range, which is the shape of that table but not its exact steps. The quarterly figures are then indexed forward like the pension above.' },
  // ---- federal income tax ----
  { id: 'fedBrackets', group: 'fed', name: 'Federal tax brackets and rates', year: 2026, symbol: 'FED_BRACKETS',
    value: () => FED_BRACKETS.map(b => `${b.upto === Infinity ? '∞' : b.upto.toLocaleString('en-US')} @ ${(b.rate*100).toFixed(2)}%`).join(' · '),
    source: 'CRA — Canadian income tax rates for individuals (current year)', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/frequently-asked-questions-individuals/canadian-income-tax-rates-individuals-current-previous-years.html',
    checked: '2026-09-14', note: 'Thresholds are indexed forward each plan year at CPI minus a 0.15-point haircut (CONSERVATIVE_HAIRCUT), not at the official indexation factor.' },
  { id: 'fedBpa', group: 'fed', name: 'Federal basic personal amount (enhanced, phased out across bracket 4)', year: 2026, symbol: 'FED_BPA_MAX / FED_BPA_MIN / FED_BPA_PHASE_LO / _HI',
    value: () => `$${FED_BPA_MAX.toLocaleString('en-US')} → $${FED_BPA_MIN.toLocaleString('en-US')} between $${FED_BPA_PHASE_LO.toLocaleString('en-US')} and $${FED_BPA_PHASE_HI.toLocaleString('en-US')}`,
    source: 'CRA — Line 30000 basic personal amount', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-30000-basic-personal-amount.html',
    checked: '2026-09-14', note: '' },
  { id: 'fedAge', group: 'fed', name: 'Federal age amount (65+) and its income threshold', year: 2026, symbol: 'FED_AGE_MAX / FED_AGE_THRESH',
    value: () => `$${FED_AGE_MAX.toLocaleString('en-US')}, reduced by 15% of net income over $${FED_AGE_THRESH.toLocaleString('en-US')}`,
    source: 'CRA — Line 30100 age amount', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-30100-age-amount.html',
    checked: '2026-09-14', note: 'Indexed forward like the brackets.' },
  { id: 'fedPension', group: 'fed', name: 'Federal pension income amount', year: 2026, symbol: 'FED_PENSION_MAX',
    value: () => `$${FED_PENSION_MAX.toLocaleString('en-US')} of eligible pension income (DB at any age; RRIF/LIF from 65)`,
    source: 'CRA — Line 31400 pension income amount', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-31400-pension-income-amount.html',
    checked: '2026-09-14', note: 'Deliberately not indexed — CRA has never indexed it.' },
  { id: 'qcAbatement', group: 'fed', name: 'Quebec abatement of federal tax', year: 2026, symbol: 'PROVINCE_TAX_TABLES.quebec.hasFederalAbatement',
    value: () => '16.5% of basic federal tax for Quebec residents',
    source: 'CRA — Line 44000 refundable Quebec abatement', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-44000-refundable-quebec-abatement.html',
    checked: '2026-09-14', note: '' },
  { id: 'capGainsInclusion', group: 'fed', name: 'Capital gains inclusion rate', year: 2026, symbol: 'CAP_GAINS_INCLUSION_RATE',
    value: () => `${(CAP_GAINS_INCLUSION_RATE*100).toFixed(0)}% of a realised or deemed-realised gain is taxable income`,
    source: 'Income Tax Act s.38(a); CRA - Line 12700 capital gains', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/personal-income/line-12700-capital-gains.html',
    checked: '2026-09-20', note: 'Applied on an asset sold inside the horizon, a Non-Reg withdrawal in realistic-tax mode, the deemed disposition at death of Non-Reg and of a still-owned asset, and the survivor\u2019s draw on an inherited Non-Reg account. The 2024 proposal to raise the rate above $250,000 of annual gains was not enacted and is not modelled.' },
  { id: 'fedAgeReduction', group: 'fed', name: 'Federal age amount reduction rate', year: 2026, symbol: 'FED_AGE_CREDIT_REDUCTION',
    value: () => `the age amount falls by ${(FED_AGE_CREDIT_REDUCTION*100).toFixed(0)}% of net income over $${FED_AGE_THRESH.toLocaleString('en-US')}`,
    source: 'CRA - Line 30100 age amount', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/line-30100-age-amount.html',
    checked: '2026-09-20', note: 'Numerically the same as the OAS recovery rate and a different rule; named separately so a change to one cannot silently move the other.' },
  // ---- provincial income tax ----
  { id: 'qcBrackets', group: 'prov', name: 'Quebec tax brackets, rates and basic personal amount', year: 2026, symbol: 'QC_BRACKETS / QC_BPA',
    value: () => QC_BRACKETS.map(b => `${b.upto === Infinity ? '∞' : b.upto.toLocaleString('en-US')} @ ${(b.rate*100).toFixed(2)}%`).join(' · ') + `; BPA $${QC_BPA.toLocaleString('en-US')}`,
    source: 'Revenu Québec — Income tax rates', url: 'https://www.revenuquebec.ca/en/citizens/income-tax-return/completing-your-income-tax-return/income-tax-rates/',
    checked: '2026-09-14', note: 'Quebec\'s BPA is not income-phased-out.' },
  { id: 'onBrackets', group: 'prov', name: 'Ontario tax brackets, basic personal amount and surtax', year: 2026, symbol: 'PROVINCE_TAX_TABLES.ontario',
    value: () => { const o = PROVINCE_TAX_TABLES.ontario; return o.brackets.map(b => `${b.upto === Infinity ? '∞' : b.upto.toLocaleString('en-US')} @ ${(b.rate*100).toFixed(2)}%`).join(' · ') + `; BPA $${o.bpa.toLocaleString('en-US')}; surtax ${o.surtax.tiers.map(t_ => `${(t_.rate*100).toFixed(0)}% over $${t_.threshold.toLocaleString('en-US')}`).join(' + ')}`; },
    source: 'Ontario — Personal income tax', url: 'https://www.ontario.ca/page/personal-income-tax',
    checked: '2026-09-14', note: 'BC and Alberta tables are kept in the code but not selectable.' },
  { id: 'dtc', group: 'prov', name: 'Eligible-dividend gross-up and tax credits (federal + province)', year: 2026, symbol: 'PROVINCE_TAX_TABLES[*].dtcRate',
    value: () => `gross-up 38%; federal credit 15.0198% of the grossed-up dividend; Quebec ${(PROVINCE_TAX_TABLES.quebec.dtcRate*100).toFixed(2)}% (= 16.146% of the actual dividend); Ontario ${(PROVINCE_TAX_TABLES.ontario.dtcRate*100).toFixed(2)}%`,
    source: 'Revenu Québec TP-1 line 415 instructions; taxtips.ca dividend tax credit tables', url: 'https://www.taxtips.ca/dtc/enhanced-dividend-tax-credit.htm',
    checked: '2026-09-16', note: 'Only used when "Realistic Non-Reg tax" is on. Quebec\'s published figure is a share of the actual dividend; the engine stores it as a share of the grossed-up amount (11.70%).' },
  // ---- health levies ----
  { id: 'onHealth', group: 'levy', name: 'Ontario Health Premium steps', year: 2026, symbol: 'ON_HEALTH_PREMIUM_STEPS',
    value: () => ON_HEALTH_PREMIUM_STEPS.map(st => `from $${st[0].toLocaleString('en-US')}: $${st[1]} + ${(st[2]*100).toFixed(0)}% of excess, cap $${st[3]}`).join(' · '),
    source: 'Ontario — Health Premium', url: 'https://www.ontario.ca/page/health-premium',
    checked: '2026-09-17', note: 'Steps are not indexed by Ontario; kept flat here too.' },
  { id: 'qcHsf', group: 'levy', name: 'Quebec Health Services Fund contribution', year: 2026, symbol: 'QC_HSF_2026',
    value: () => `1% of non-employment income over $${QC_HSF_2026.threshold1.toLocaleString('en-US')} (max $${QC_HSF_2026.cap1}), then over $${QC_HSF_2026.threshold2.toLocaleString('en-US')} up to $${QC_HSF_2026.max.toLocaleString('en-US')}`,
    source: 'Revenu Québec — Schedule F, Contribution to the Health Services Fund', url: 'https://www.revenuquebec.ca/en/citizens/income-tax-return/completing-your-income-tax-return/how-to-complete-your-income-tax-return/line-446/',
    checked: '2026-09-17', note: 'Base = taxable income minus OAS; employment income excluded (second review A6).' },
  { id: 'qcRamq', group: 'levy', name: 'Quebec prescription-drug-plan (RAMQ) premium', year: 2026, symbol: 'QC_RAMQ_2026',
    value: () => `up to $${QC_RAMQ_2026.max} per adult from age ${QC_RAMQ_2026.fromAge}; ${(QC_RAMQ_2026.rate*100).toFixed(2)}% of family income over $${QC_RAMQ_2026.exemptionSingle.toLocaleString('en-US')}`,
    source: 'RAMQ — Premium rates in effect (July–June cycle, blended to the tax year)', url: 'https://www.ramq.gouv.qc.ca/en/citizens/prescription-drug-insurance/premium-payable',
    checked: '2026-09-17', note: 'Approximation: the single-adult first rate is used across the whole phase-in (the real schedule switches to 11.69% after the first band — worth under $130/yr); GIS-based exemptions and private-plan coverage before 65 are not modelled.' },
  // ---- OAS / CPP / QPP ----
  { id: 'oas', group: 'benefits', name: 'OAS monthly maximum at 65, deferral rate, base year', year: 2026, symbol: 'OAS_BASE_MONTHLY / OAS_DEFER_RATE_MONTHLY / OAS_BASE_YEAR',
    value: () => `$${OAS_BASE_MONTHLY.toFixed(2)}/month (${OAS_BASE_YEAR}); +${(OAS_DEFER_RATE_MONTHLY*100).toFixed(1)}% per month of deferral after 65 (max 36%)`,
    source: 'Government of Canada — OAS payment amounts', url: 'https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/payments.html',
    checked: '2026-09-10', note: 'Indexed to the payment year at the plan\'s CPI; the 10% top-up at 75 is applied; the residence fraction uses the years entered on the Profile tab.' },
  { id: 'oasClawback', group: 'benefits', name: 'OAS recovery tax threshold and rate', year: 2026, symbol: 'OAS_RECOVERY_BASE_THRESHOLD / OAS_RECOVERY_BASE_YEAR / OAS_CLAWBACK_RATE',
    value: () => `${(OAS_CLAWBACK_RATE*100).toFixed(0)}% of net income over $${OAS_RECOVERY_BASE_THRESHOLD.toLocaleString('en-US')} (${OAS_RECOVERY_BASE_YEAR} income year), up to the full OAS`,
    source: 'Government of Canada — OAS recovery tax', url: 'https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/recovery-tax.html',
    checked: '2026-09-10', note: 'Threshold indexed forward like the brackets; applied per person in the household view; the final return\'s clawback is applied in the estate.' },
  { id: 'cppqpp', group: 'benefits', name: 'CPP and QPP maximum monthly pension at 65, base year', year: 2026, symbol: 'CPP_MAX_MONTHLY_AT_65_2026 / QPP_MAX_MONTHLY_AT_65_2026 / QPP_BASE_YEAR',
    value: () => `CPP $${CPP_MAX_MONTHLY_AT_65_2026.toFixed(2)}, QPP $${QPP_MAX_MONTHLY_AT_65_2026.toFixed(2)} (${QPP_BASE_YEAR}); −0.6%/month before 65, +0.7%/month after, to 70 (QPP: 72)`,
    source: 'Government of Canada — CPP payment amounts; Retraite Québec — QPP amounts', url: 'https://www.canada.ca/en/services/benefits/publicpensions/cpp/cpp-benefit/amount.html',
    checked: '2026-09-17', note: 'The user enters their own estimate at 65; the maximum is a reference. Indexed to the payment year (second review A5).' },
  { id: 'ympe', group: 'benefits', name: 'YMPE (CPP/QPP)', year: 2026, symbol: 'YMPE_2026',
    value: () => `$${YMPE_2026.toLocaleString('en-US')}`,
    source: 'CRA — CPP contribution rates, maximums and exemptions', url: 'https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/payroll-deductions-contributions/canada-pension-plan-cpp/cpp-contribution-rates-maximums-exemptions.html',
    checked: '2026-09-10', note: 'Used by the LIF small-balance unlocking test.' },
  // ---- registered-plan rules ----
  { id: 'rrifMin', group: 'plans', name: 'RRIF minimum withdrawal factors', year: 2026, symbol: 'RRIF_MIN_FACTORS_71_PLUS (+ 1/(90−age) under 71)',
    value: () => `1/(90 − age) before 71; ${(RRIF_MIN_FACTORS_71_PLUS[71]*100).toFixed(2)}% at 71 … ${(RRIF_MIN_FACTORS_71_PLUS[94]*100).toFixed(2)}% at 94, 20% from 95`,
    source: 'CRA — RRIF minimum amount (prescribed factors)', url: 'https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/completing-slips-summaries/t4rsp-t4rif-information-returns/payments/chart-prescribed-factors.html',
    checked: '2026-09-17', note: 'Factors have been unchanged since 2015; no indexation.' },
  { id: 'lifMax', group: 'plans', name: 'LIF maximum withdrawal', year: 2026, symbol: 'FED_LIF_MAX / PROV_LIF_FLOOR_RATE / CURRENT_LONG_BOND_RATE',
    value: () => `provinces: the greater of the reference-rate annuity formula (floor ${(PROV_LIF_FLOOR_RATE*100).toFixed(0)}%, long bond ${(CURRENT_LONG_BOND_RATE*100).toFixed(2)}%) and the RRIF minimum; federal: the published table (e.g. ${FED_LIF_MAX[65]}% at 65)`,
    source: 'OSFI — LIF maximum withdrawal table; Retraite Québec / FSRA — LIF rules', url: 'https://www.osfi-bsif.gc.ca/en/supervision/pension-plans/pension-plans-guidance/life-income-fund-maximum-annual-amount',
    checked: '2026-09-17', note: 'With the long-bond rate below 6% the floor is what binds; the federal table is the CANSIM-based OSFI schedule for the year.' },
  { id: 'lifUnlock', group: 'plans', name: 'LIF one-time 50% unlocking and small-balance unlocking', year: 2026, symbol: '_applyHalfUnlock / YMPE_2026',
    value: () => 'Quebec/Ontario: one-time transfer of up to 50% to a RRIF within 60 days; small balance below 40% of YMPE at 65+ may be withdrawn in full',
    source: 'FSRA — Unlocking your locked-in account; Retraite Québec — LIF', url: 'https://www.fsrao.ca/consumers/pensions/unlocking-your-locked-account',
    checked: '2026-09-10', note: 'Federally regulated pensions: the federal rules and table instead.' },
  { id: 'tfsa', group: 'plans', name: 'TFSA annual limit and base year', year: 2026, symbol: '_TFSA_ANNUAL / _TFSA_ANNUAL_BASE_YEAR',
    value: () => `$${_TFSA_ANNUAL.toLocaleString('en-US')} (${_TFSA_ANNUAL_BASE_YEAR}); grown at the plan\'s indexation, rounded to $500`,
    source: 'CRA — TFSA contribution room', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/tax-free-savings-account/contributions.html',
    checked: '2026-09-17', note: 'Opening room is the user\'s own figure (or a preset); the limit only adds room from the following year.' },
  { id: 'rrspLimit', group: 'plans', name: 'RRSP dollar limit and base year', year: 2026, symbol: '_RRSP_LIMIT_BASE / _RRSP_LIMIT_BASE_YEAR',
    value: () => `$${_RRSP_LIMIT_BASE.toLocaleString('en-US')} (${_RRSP_LIMIT_BASE_YEAR}); 18% of earned income up to the limit, less the DB pension adjustment`,
    source: 'CRA — RRSP dollar limits', url: 'https://www.canada.ca/en/revenue-agency/services/tax/registered-plans-administrators/pspa/mp-rrsp-dpsp-tfsa-limits-ympe.html',
    checked: '2026-09-14', note: 'Grown at the plan\'s indexation from the base year.' },
  // ---- non-resident ----
  { id: 'nrRates', group: 'nonres', name: 'Non-resident withholding rates', year: 2026, symbol: 'NR_LUMP_SUM_RATE + the Profile tab\'s editable pension / dividend / interest rates',
    value: () => `Part XIII 25% statutory (lump sums always ${(NR_LUMP_SUM_RATE*100).toFixed(0)}%); periodic pension, dividend and interest rates are the user\'s entries (treaty rates)`,
    source: 'CRA — Part XIII tax on non-residents (Information Circular IC76-16R)', url: 'https://www.canada.ca/en/revenue-agency/services/tax/international-non-residents/individuals-leaving-entering-canada-non-residents/non-residents-canada.html',
    checked: '2026-09-17', note: 'Section 217 election not modelled; real property gains taxed as Part I income with the 48% surtax (second review A5).' },
  // ---- assumptions and reference data ----
  { id: 'indexation', group: 'assumptions', name: 'Indexation of tax and benefit figures', year: null, symbol: 'CONSERVATIVE_HAIRCUT / _idxFactor',
    value: () => `plan CPI minus ${(CONSERVATIVE_HAIRCUT*100).toFixed(2)} points per year, compounded from the base year`,
    source: 'App assumption (CRA indexes at the September-to-September CPI change; the haircut is deliberate conservatism)', url: '',
    checked: '2026-09-14', note: 'Applies to brackets, BPA, age amount, OAS threshold, TFSA and RRSP limits; not to the pension income amount or the Ontario Health Premium.' },
  { id: 'nonregRate', group: 'assumptions', name: 'Flat Non-Registered growth rate (resident / non-resident) and Emergency Fund rate', year: null, symbol: '_SIM_GNREG / _SIM_GNREG_NONRES / _SIM_GEMERG',
    value: () => `${(_SIM_GNREG*100).toFixed(1)}% / ${(_SIM_GNREG_NONRES*100).toFixed(1)}% / ${(_SIM_GEMERG*100).toFixed(1)}%`,
    source: 'App assumption', url: '',
    checked: '2026-09-10', note: 'Overridable per age through the rate overrides; the registered/TFSA rate is the Retirement Income tab\'s growth input.' },
  { id: 'mortality', group: 'assumptions', name: 'Mortality table (P(alive), life expectancy, mortality-weighted Monte Carlo)', year: 2022, symbol: 'MORTALITY_QX',
    value: () => `qx at 5-year ages 50–110 (unisex = average of male and female), log-linear between; e.g. 65 → ~${Math.round(_lifeExpectancyAge(65, 'u'))} unisex`,
    source: 'Statistics Canada — Life tables, Canada, 2020–2022 (table 13-10-0114-01)', url: 'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1310011401',
    checked: '2026-09-17', note: 'Rounded five-year points, interpolated; below 50 extrapolated. Nothing in the deterministic plan uses it.' },
  { id: 'sp500', group: 'assumptions', name: 'Historical equity returns (Monte Carlo bootstrap, Reverse Sequence test)', year: 2025, symbol: 'SP500_ANNUAL_RETURNS',
    value: () => `S&P 500 total returns ${SP500_ANNUAL_RETURNS_START_YEAR}–${SP500_ANNUAL_RETURNS_START_YEAR + SP500_ANNUAL_RETURNS.length - 1} (${SP500_ANNUAL_RETURNS.length} years), mean ${(_SP500_HIST_MEAN*100).toFixed(1)}%, stdev ${(_SP500_HIST_STDEV*100).toFixed(1)}%; Reverse Sequence window starts ${SEQ_TEST_START_YEAR}`,
    source: 'S&P 500 annual total returns (e.g. NYU Stern / Damodaran historical returns)', url: 'https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html',
    checked: '2026-09-17', note: 'US series in USD, standardized to the user\'s own mean and stdev; used for the shape of returns, not their level.' },
  { id: 'bond', group: 'assumptions', name: 'Canadian bond sleeve (Blended Monte Carlo)', year: null, symbol: 'CANADA_BOND_MEAN_DEFAULT / CANADA_BOND_MEAN_HISTORICAL / CANADA_BOND_STDEV',
    value: () => `default mean ${(CANADA_BOND_MEAN_DEFAULT*100).toFixed(1)}% (historical ${(CANADA_BOND_MEAN_HISTORICAL*100).toFixed(1)}%), stdev ${(CANADA_BOND_STDEV*100).toFixed(2)}%`,
    source: 'taxtips.ca historical returns (long bonds); PWL Capital volatility estimate', url: 'https://www.taxtips.ca/stocksandbonds/investment-returns.htm',
    checked: '2026-09-17', note: 'Drawn independently each year (no historical bond sequence available); the mean is an input on the Monte Carlo controls.' },
  { id: 'phases', group: 'assumptions', name: 'Retirement phases (Go-Go / Slow-Go / No-Go) and the phased Sustainable Spend shape', year: null, symbol: 'RETIREMENT_PHASE_GOGO_END / _SLOWGO_END / SUSTAIN_PHASE_SHAPE',
    value: () => `Go-Go to ${RETIREMENT_PHASE_GOGO_END}, Slow-Go to ${RETIREMENT_PHASE_SLOWGO_END}, No-Go after; phased shape ${SUSTAIN_PHASE_SHAPE.gogo}/${SUSTAIN_PHASE_SHAPE.slowgo}/${SUSTAIN_PHASE_SHAPE.nogo}`,
    source: 'App assumption (common planning convention)', url: '',
    checked: '2026-09-10', note: 'Display and the phased overlay only; the Budget itself drives spending.' },
];
// The register as plain data (for the Help table, the Markdown tool and
// the snapshot): `value` evaluated, errors caught per row.
function _fmtRegisterMoney(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
function _rulesRegisterRows() {
  return RULES_REGISTER.map(r => { let v = ''; try { v = r.value(); } catch (e) { v = '(unavailable)'; } return { id: r.id, group: r.group, name: r.name, year: r.year, symbol: r.symbol, value: v, source: r.source, url: r.url, checked: r.checked, note: r.note }; });
}

// ── Person inputs ──────────────────────────────────────────────────────────
// The complete list of engine globals that describe ONE person's plan.
// Adding an engine global that differs per person means adding it here and
// in the two builders below -- nowhere else.
var PERSON_INPUT_KEYS = ['settings', 'dbBase', 'dbFrozen', 'useDBPension', 'targetIncome', 'rrifOverride', 'tfsaOverride', 'rateOverride', 'assets', 'halfUnlock', 'meltdownEnabled', 'useEmergencyFund', 'budgetTotalsAtAge', 'emergencyFundAnnualNom', 'budgetShare', 'externalFlows', 'retiredAtAge', 'extraPensionIncome', 'extraOtherIncome', 'extraTaxFreeIncome', 'householdShareFrom'];
// External cash flows by age (2026-09-19, household sharing fix): money
// that reaches (+) or leaves (-) this person's hands in a year from OUTSIDE
// their own plan -- a gift from the spouse's surplus, or the gift they
// made. null = none. Read by simulateResidentFixed() through
// _externalFlowAt(); installed only through the person-inputs object.
// N17: WHEN THIS PERSON RETIRED, which is not the same thing as where the
// simulation starts. N9 let a retiree roll the plan forward past their Start
// Age -- the Start Age becomes history and the projection restarts at the
// current age from the actual balances -- and from that moment `ra` means
// "the first year simulated", not "the year I retired". Every rule keyed on
// `ra` that means the latter has to read this instead, or a re-based plan
// looks like a brand-new retirement: the DB pension pays the entitlement of
// an age the person never retired at, a LIF commutation clock restarts, and
// an asset sale already made comes round again.
//
// Null means they are the same thing (nobody has rolled past their Start
// Age yet), which is every plan until N9 is used.
var _retiredAtAge = null;
function _retirementAge(ra) {
  return (Number.isFinite(_retiredAtAge) && _retiredAtAge < ra) ? _retiredAtAge : ra;
}
var _externalFlows = null;
function _externalFlowAt(age) { const v = _externalFlows && _externalFlows[age]; return Number.isFinite(v) ? v : 0; }
// N14 (2026-09-20): what a SURVIVOR receives and spends, fed into that
// person's own run instead of layered onto the merged household year.
// Until N14 the merge added the survivor's DB portion, their CPP/QPP
// survivor's pension and the OAS Allowance to the merged year's taxable /
// tax-free figures, and added their extra spending straight to that year's
// shortfall -- so the income funded nothing, and the spending was reported
// as a shortfall even when the person's own row had just deposited a
// surplus. These four inputs put all of it where item 125 put gifts: in the
// simulation, so the row carries it and every reader of the row agrees.
//   _extraPensionIncome  taxable AND eligible pension income (the survivor's
//                        share of the deceased's DB pension), by the
//                        survivor's own age -- folded into the row's db.
//   _extraOtherIncome    taxable but NOT eligible pension income (the
//                        CPP/QPP survivor's pension, which cannot be split)
//                        -- folded into the row's qpp.
//   _extraTaxFreeIncome  cash that is never taxed (the OAS Allowance for the
//                        Survivor) -- joins the year's external cash flow.
//   _householdShareFrom  {age, share}: the person's share of the household
//                        budget changes to that share from that age on,
//                        living alone costs more than half of living
//                        together.
var _extraPensionIncome = null, _extraOtherIncome = null, _extraTaxFreeIncome = null, _householdShareFrom = null;
function _byAgeAt(map, age) { const v = map && map[age]; return Number.isFinite(v) ? v : 0; }
function _extraPensionAt(age) { return _byAgeAt(_extraPensionIncome, age); }
function _extraOtherAt(age) { return _byAgeAt(_extraOtherIncome, age); }
function _extraTaxFreeAt(age) { return _byAgeAt(_extraTaxFreeIncome, age); }
// This person's share of the household budget at a given age -- their own
// share until they are the survivor, the survivor ratio afterwards.
function _shareAt(age) {
  const f = _householdShareFrom;
  return (f && Number.isFinite(f.age) && Number.isFinite(f.share) && age >= f.age) ? f.share : _householdPrimaryShare;
}
// The live primary plan's inputs, read from the globals as they are now.
function _primaryPersonInputs() {
  return {
    settings: _engineSettingsOverride, // null = read the DOM
    dbBase: DB_BASE, dbFrozen: DB_FROZEN, useDBPension: useDBPension,
    targetIncome: TARGET_INCOME,
    rrifOverride: RRIF_OVERRIDE, tfsaOverride: TFSA_OVERRIDE, rateOverride: RATE_OVERRIDE, assets: ASSETS,
    halfUnlock: halfUnlock, meltdownEnabled: meltdownEnabled, useEmergencyFund: useEmergencyFund,
    budgetTotalsAtAge: _budgetTotalsAtAge, emergencyFundAnnualNom: _emergencyFundAnnualNom,
    budgetShare: _householdPrimaryShare,
    externalFlows: _externalFlows, retiredAtAge: _retiredAtAge,
    extraPensionIncome: _extraPensionIncome, extraOtherIncome: _extraOtherIncome,
    extraTaxFreeIncome: _extraTaxFreeIncome, householdShareFrom: _householdShareFrom,
  };
}
// Installs an inputs object into the engine's globals. Private to
// _withPersonInputs(); never call it without the matching restore.
function _installPersonInputs(pi) {
  _engineSettingsOverride = pi.settings;
  DB_BASE = pi.dbBase; DB_FROZEN = pi.dbFrozen; useDBPension = pi.useDBPension;
  TARGET_INCOME = pi.targetIncome;
  RRIF_OVERRIDE = pi.rrifOverride; TFSA_OVERRIDE = pi.tfsaOverride; RATE_OVERRIDE = pi.rateOverride; ASSETS = pi.assets;
  halfUnlock = pi.halfUnlock; meltdownEnabled = pi.meltdownEnabled; useEmergencyFund = pi.useEmergencyFund;
  _budgetTotalsAtAge = pi.budgetTotalsAtAge; _emergencyFundAnnualNom = pi.emergencyFundAnnualNom;
  _householdPrimaryShare = pi.budgetShare;
  _externalFlows = pi.externalFlows || null;
  _retiredAtAge = Number.isFinite(pi.retiredAtAge) ? pi.retiredAtAge : null;
  _extraPensionIncome = pi.extraPensionIncome || null; _extraOtherIncome = pi.extraOtherIncome || null;
  _extraTaxFreeIncome = pi.extraTaxFreeIncome || null; _householdShareFrom = pi.householdShareFrom || null;
}
// Runs fn() with `inputs` installed, restoring the previous inputs
// afterwards whatever happens. null/undefined = the current context, no
// swap at all (the primary's own figures, evaluated where they always were).
function _withPersonInputs(inputs, fn) {
  if (!inputs) return fn();
  const saved = _primaryPersonInputs();
  _installPersonInputs(inputs);
  try { return fn(); } finally { _installPersonInputs(saved); }
}
// The spouse's inputs, built from the Profile tab's household settings
// `sp` (see _householdSettingsFromDom in the main file: curAge, retAge,
// qppStart, oasStart, qppBase65, oasYears, qppEligible, oasEligible, dbBase,
// dbCola, lif, rrsp, tfsa, nonreg, rrspAnnual, tfsaAnnual, budgetShare
// 0..1). `live` is the primary's live engine settings, `primary` the
// primary's inputs -- the household Budget and Target are entered in the
// primary's age terms, so ageDiff (spouse age - primary age) maps them onto
// the spouse's ages, and the Budget is evaluated in the PRIMARY's context
// (its escalation runs from the primary's current age -- second review H1).
function _spousePersonInputs(sp, live, primary) {
  const ageDiff = sp.curAge - live.personAge;
  const share = Math.max(0, Math.min(1, sp.budgetShare));
  const dbBaseAmt = Math.max(0, sp.dbBase || 0);
  const frozen = Math.round(dbBaseAmt * Math.pow(1 + (sp.dbCola || 0), live.dbFreeze - 64));
  const dbBase = {}, dbFrozen = {};
  DB_CHECKPOINTS.forEach(a => { dbBase[a] = dbBaseAmt; dbFrozen[a] = frozen; });
  // Target Income: the spouse's share of the primary's band for the same
  // calendar year (primary age = spouse age - ageDiff), every age filled
  // so _getSpendReal() never falls back to the single-person defaults.
  // N14: neither of these applies the share any more -- `budgetShare` below
  // carries it, so _getSpendReal / _planBudgetTotalsAtAge scale both people
  // in the same place and one age-aware share (_shareAt) serves both.
  const targetIncome = {};
  for (let a = TARGET_INCOME_MIN_AGE; a <= TARGET_INCOME_MAX_AGE; a++) {
    const pa = Math.max(TARGET_INCOME_MIN_AGE, Math.min(TARGET_INCOME_MAX_AGE, a - ageDiff));
    const v = primary.targetIncome[pa];
    targetIncome[a] = (typeof v === 'number' && !isNaN(v)) ? v : _defaultTargetForAge(pa);
  }
  const primaryBudget = primary.budgetTotalsAtAge;
  const budgetTotalsAtAge = (age) => _withPersonInputs(primary, () => primaryBudget(age - ageDiff)) || {};
  return {
    settings: Object.assign({}, live, {
      personAge: sp.curAge, qppBase65: Math.max(0, sp.qppBase65 || 0), oasQualifyingYears: sp.oasYears,
      qppEligible: sp.qppEligible !== false, oasEligible: sp.oasEligible !== false,
      dbCola: sp.dbCola || 0, dbBridgeAmount: 0, dbPensionAdjustmentAnnual: 0,
    }),
    dbBase, dbFrozen, useDBPension: dbBaseAmt > 0,
    targetIncome,
    rrifOverride: {}, tfsaOverride: {}, rateOverride: { lif:{}, rrif:{}, tfsa:{}, nonreg:{} }, assets: [],
    halfUnlock: false, meltdownEnabled: false, useEmergencyFund: false,
    budgetTotalsAtAge, emergencyFundAnnualNom: () => 0,
    budgetShare: share, // applied in _getSpendReal / _planBudgetTotalsAtAge, like the primary's (N14)
    externalFlows: null, retiredAtAge: null,
    extraPensionIncome: null, extraOtherIncome: null, extraTaxFreeIncome: null, householdShareFrom: null,
    ageDiff, share,
  };
}
// Turns a survivor context (see mergeHousehold) into the four person-input
// fields that carry it. Null clears them, which is what a person who is not
// a survivor -- or a first pass, before any death has been seen -- needs.
function _survivorInputs(ctx) {
  return ctx
    ? { extraPensionIncome: ctx.pension, extraOtherIncome: ctx.other, extraTaxFreeIncome: ctx.taxFree, householdShareFrom: ctx.shareFrom }
    : { extraPensionIncome: null, extraOtherIncome: null, extraTaxFreeIncome: null, householdShareFrom: null };
}
// Runs the spouse's own retirement simulation from explicit inputs. The
// result carries `inputs` so mergeHousehold() evaluates every spouse-side
// tax / threshold / estate figure in the same context (second review H2:
// the spouse's estate used to be computed after the restore, under the
// primary's indexation and against the primary's assets -- a still-unsold
// home counted twice for a same-age couple). `settings` is kept as an
// alias of inputs.settings for existing callers.
// externalFlows (optional): {spouseAge: amount} gifts received (+) / made
// (-), from the household merge's sharing pass.
function runSpouseSim(sp, externalFlows, survCtx) {
  const live = _liveEngineSettings();
  const primary = _primaryPersonInputs();
  const inputs = _spousePersonInputs(sp, live, primary);
  if (externalFlows) inputs.externalFlows = externalFlows;
  // N14: what this person receives and spends AS THE SURVIVOR, so their own
  // run funds it (see _survivorInputs / mergeHousehold).
  Object.assign(inputs, _survivorInputs(survCtx));
  // N21: the spouse lives where the plan does. Their savings grow at the
  // residency's own Non-Reg rate and their retirement runs through the same
  // loop, so a non-resident couple is a couple rather than one non-resident
  // and one accidental resident.
  const R = _currentResidency();
  const rawPort = _spouseOpeningPortfolio(sp, live.simG, R.nonregRate());
  const rows = _withPersonInputs(inputs, () => _simulateYears(sp.retAge, sp.qppStart, sp.oasStart, rawPort, undefined, R));
  const estate = _withPersonInputs(inputs, () => computeEstate(rows));
  return { rows, ra: sp.retAge, rawPort, ageDiff: inputs.ageDiff, share: inputs.share, estate, settings: inputs.settings, inputs };
}

// Per-person tax for one household year, at a given transfer `t` of
// eligible pension income from A (higher) to B (lower). `p` is
// {age, taxable, elig, oas, inputs} -- elig = federal eligible pension
// income (_eligiblePensionIncome), inputs = that person's inputs object
// (null for the primary). Returns {fed, prov, claw, total}.
// _withEngineSettings(): runs fn() with only the engine-settings override
// swapped (null = the live primary). Kept for callers that have a settings
// object and nothing else (tests); the merge itself uses the full inputs.
function _withEngineSettings(settings, fn) {
  const prev = _engineSettingsOverride;
  _engineSettingsOverride = settings === undefined ? prev : settings;
  try { return fn(); } finally { _engineSettingsOverride = prev; }
}
function _personTaxAfterSplit(p, deltaFed, deltaProv, eligDelta) {
  return _withPersonInputs(p.inputs || null, () => {
    const incFed = Math.max(0, p.taxable + deltaFed);
    const incProv = Math.max(0, p.taxable + deltaProv);
    const elig = Math.max(0, p.elig + eligDelta);
    // N21: the same tax engine the person's own rows were produced with.
    // A non-resident pays Part XIII withholding and no provincial tax, so
    // dProv.prov is 0 for them and the split loop below never runs.
    const R = _currentResidency();
    const dFed = R.taxDetail(incFed, p.age, elig, p.oas || 0);
    const dProv = deltaProv === deltaFed ? dFed : R.taxDetail(incProv, p.age, elig, p.oas || 0);
    const claw = Math.round(Math.max(0, Math.min((incFed - _oasThresh(p.age)) * OAS_CLAWBACK_RATE, p.oas || 0)));
    return { fed: dFed.fed, prov: dProv.prov, claw, total: dFed.fed + dProv.prov + claw };
  });
}
// Best pension-income split for one year. Returns {t, tProv, noSplit,
// withSplit, saving, a:{...}, b:{...}, from} where `from` is 'p' or 's'
// (who transfers). Grid search over 0..50% of the transferor's eligible
// pension income, refined once around the best point.
function optimalPensionSplit(P, S, provKey) {
  const order = P.taxable >= S.taxable ? [P, S, 'p'] : [S, P, 's'];
  const A = order[0], B = order[1], from = order[2];
  const maxFed = 0.5 * Math.max(0, A.elig || 0);
  const provAllowed = provKey === 'quebec' ? A.age >= 65 : true;
  const eval_ = t => {
    const tp = provAllowed ? t : 0;
    const eligOutA = -Math.min(t, A.elig || 0);
    const eligInB = (A.age >= 65 || B.age >= 65) ? t : 0; // the split amount qualifies for the recipient's pension credit when the TRANSFEROR is 65+ (ITA 118(7) "qualified pension income"), or when the recipient is 65+ (2026-09-17 second review, L2)
    const a = _personTaxAfterSplit(A, -t, -tp, eligOutA);
    const b = _personTaxAfterSplit(B, t, tp, eligInB);
    return { total: a.total + b.total, a, b };
  };
  const base = eval_(0);
  let best = { t: 0, r: base };
  if (maxFed > 0) {
    const steps = 25;
    for (let i = 1; i <= steps; i++) { const t = Math.round(maxFed * i / steps); const r = eval_(t); if (r.total < best.r.total - 0.5) best = { t, r }; }
    const step = maxFed / steps;
    for (let t = Math.max(0, best.t - step); t <= Math.min(maxFed, best.t + step); t += Math.max(50, step / 10)) { const tt = Math.round(t); const r = eval_(tt); if (r.total < best.r.total - 0.5) best = { t: tt, r }; }
  }
  const aRes = best.r.a, bRes = best.r.b;
  return {
    t: best.t, tProv: provAllowed ? best.t : 0, from,
    noSplit: base.total, withSplit: best.r.total, saving: Math.max(0, base.total - best.r.total),
    p: from === 'p' ? aRes : bRes, s: from === 'p' ? bRes : aRes,
    pNoSplit: from === 'p' ? base.a : base.b, sNoSplit: from === 'p' ? base.b : base.a,
  };
}
// Incremental tax on an extra lump on top of a base income (the death-tax
// treatment computeEstate() applies to registered balances).
function _incrementalTaxOn(base, add, age, elig) {
  if (add <= 0) return 0;
  return Math.max(0, Math.round(_calcTaxDetail(base + add, age, elig).total - _calcTaxDetail(base, age, elig).total));
}
function _rowCashFlow(r) { return (r.surplus||0) + (r.nonregDeposit||0) + (r.emergDeposit||0) - (r.tfsa||0) - (r.nonreg||0) - (r.emerg||0); }
function _rowTotalBal(r) { return (r.lifBal||0) + (r.rrspBal||0) + (r.tfsaBal||0) + (r.nonregBal||0) + (r.emergBal||0); }

// N14: opts.rerun is REQUIRED for a household in which anyone dies inside
// the horizon. The survivor's budget share and their survivor income are
// fed into that person's own simulation, which means re-running it; without
// a rerun the merge can report those figures (y.survivorDb /
// survivorPublic / survivorAllowance) but cannot fund them, and
// summary.survivorResimulated is false to say so. Every caller in the app
// and in the snapshot tool supplies one.
// The household merge. pRows: the primary's rows (nominal), sRun: the
// result of runSpouseSim() (rows + the spouse's inputs object), opts: {survivorPct (0..1), splitEnabled,
// provKey, personAge (primary), simG}. Returns {years, summary, estate}.
// ── Survivor benefits (N10, 2026-09-20) ────────────────────────────────────
// Two public benefits a surviving spouse can receive that the household
// merge ignored until N10 (it modelled only the DB survivor pension).
//
// CPP/QPP survivor's pension. At 65 and over both plans pay 60% of the
// deceased's retirement pension. Under 65 both pay a flat-rate portion plus
// a percentage of it (CPP 37.5%; QPP's own flat amount is larger). In both
// plans the survivor's own retirement pension and the survivor's pension
// are COMBINED-CAPPED at one maximum retirement pension -- which is why a
// survivor who already has a full pension of their own often receives
// little or nothing, and why this is modelled rather than assumed.
//
// The two flat-rate amounts are the one genuine approximation here: they are
// 2025 published figures carried into 2026 pending the next indexation, and
// the rules register says so. Everything else is derived from constants the
// register already owns (_qppMaxAt65Annual()), so it indexes with them.
const CPP_SURVIVOR_FLAT_ANNUAL = 2756;   // 2025: $229.67/mo flat-rate portion, under 65
const QPP_SURVIVOR_FLAT_ANNUAL = 7520;   // 2025: $626.66/mo, survivor aged 45-64
const CPP_SURVIVOR_UNDER65_PCT = 0.375;  // plus 37.5% of the deceased's retirement pension
const SURVIVOR_PCT_65PLUS = 0.60;        // both plans, 65 and over
// calYearAge: an age on the PRIMARY's scale for the calendar year being
// paid. Needed because the deceased's pension, the survivor's own pension
// and the plan maximum must all be in the SAME year's dollars: _getQPP()
// indexes every payment from QPP_BASE_YEAR, so a today's-dollar cap would
// be below every future nominal pension and silently zero this benefit out
// for good (caught in testing, 2026-09-20).
// The plan's own indexation factor for the calendar year an age falls in,
// on the primary's age scale. CPP/QPP and everything pinned to them index
// from QPP_BASE_YEAR at the conservative rate.
function _indexFactorFor(age) {
  let years = 0;
  try { years = Math.max(0, _oasProjectionYear(age) - QPP_BASE_YEAR); } catch (e) {}
  return Math.pow(1 + _conservativeRate(), years);
}
// `deceasedAnnual` is the deceased's retirement pension AS IF THEY HAD BEEN
// 65 at the time of death, in the payment year's dollars -- not what they
// were actually being paid. Service Canada: "We first calculate the amount
// that the CPP retirement pension of the deceased is, or would have been, if
// the deceased had been age 65 at the time of death." That distinction is
// the whole rule: a deferral increase earned by starting at 70 does NOT
// raise the survivor's pension, and a contributor who died before ever
// starting their pension still leaves one. Callers index the deceased's
// today's-dollar age-65 entitlement to the payment year themselves (see
// mergeHousehold) rather than passing a row's actual `qpp` figure.
function _survivorPublicPension(deceasedAnnual, survivorAge, survivorOwnAnnual, provKey, calYearAge) {
  const dec = Math.max(0, deceasedAnnual || 0);
  if (dec <= 0) return 0;
  const isQpp = provKey === 'quebec';
  const index = _indexFactorFor(Number.isFinite(calYearAge) ? calYearAge : survivorAge);
  let gross;
  if (survivorAge >= 65) gross = dec * SURVIVOR_PCT_65PLUS;
  // The flat-rate portion is a today's-dollar amount, indexed like the rest.
  else gross = (isQpp ? QPP_SURVIVOR_FLAT_ANNUAL : CPP_SURVIVOR_FLAT_ANNUAL) * index + dec * CPP_SURVIVOR_UNDER65_PCT;
  // Combined cap: own retirement pension + survivor's pension cannot exceed
  // one maximum retirement pension, in that year's dollars.
  const cap = Math.max(0, _qppMaxAt65Annual() * index - Math.max(0, survivorOwnAnnual || 0));
  return Math.round(Math.max(0, Math.min(gross, cap)));
}
// OAS Allowance for the Survivor: ages 60-64 only, for a surviving spouse
// who has not remarried, fully income-tested and gone entirely above the
// cutoff. Modelled as a straight-line phase-out from the maximum to zero
// across the income range, which is the shape of the real table.
// TAX-FREE. Service Canada calls it "a monthly tax-free payment", like the
// GIS and the Allowance it sits beside: it appears in box 21 of the
// T4A(OAS) and so in net income, but is deducted again before taxable
// income. Callers must therefore add it to available cash WITHOUT adding it
// to taxable income (see mergeHousehold). The net-income half of that
// treatment is not modelled and cannot matter here: this benefit is only
// paid from 60 to 64, to someone whose income is below the cutoff, who is
// therefore years away from receiving any OAS to claw back.
// Re-checked against Service Canada on 2026-09-20 (N18): the published
// maximum is $1,702.34/month and the income cutoff $30,696, both for the
// July-September 2026 quarter. The figures held before that pass were
// 2025's ($1,647.34/mo and $29,712), carried forward unindexed -- so the
// Allowance was understated by about $660/yr and cut off about $1,000 of
// income too early.
const OAS_ALW_SURVIVOR_MAX_ANNUAL = 20428;   // 2026 Q3: $1,702.34/mo x 12
const OAS_ALW_SURVIVOR_CUTOFF = 30696;       // 2026 Q3: annual income cutoff
function _oasAllowanceSurvivor(age, income, calYearAge) {
  if (age < 60 || age > 64) return 0;
  // Both the maximum and the cutoff are today's-dollar amounts and are
  // indexed to the payment year, for the same reason the pension above is.
  const index = _indexFactorFor(Number.isFinite(calYearAge) ? calYearAge : age);
  const cutoff = OAS_ALW_SURVIVOR_CUTOFF * index;
  const inc = Math.max(0, income || 0);
  if (inc >= cutoff) return 0;
  return Math.round(OAS_ALW_SURVIVOR_MAX_ANNUAL * index * (1 - inc / cutoff));
}
function mergeHousehold(pRows, sRun, opts) {
  const shareOn = opts.shareEnabled !== false;
  // N14: re-simulation is no longer only a sharing feature. The survivor's
  // own run has to be re-run with their survivor income and their survivor
  // budget share whether or not cash-flow sharing is on, so `canResim` (is
  // a re-run available at all) and `canShare` (should gifts be discovered)
  // are now two different questions.
  const canResim = !!(opts.rerun && typeof opts.rerun.p === 'function' && typeof opts.rerun.s === 'function');
  const canShare = shareOn && canResim;
  const base = { pRows, sRows: sRun.rows };
  let flows = { p: {}, s: {} };
  // The survivor context is discovered by the merge and fed back into the
  // run that produced it, so it converges rather than resolving in one go:
  // the Allowance is income-tested on income that includes the survivor's
  // pension, and the pension is capped against the survivor's own. Both
  // settle after a pass or two, the same way the gifts do.
  let surv = { p: null, s: null };
  let cur = _mergeHouseholdOnce(pRows, sRun, opts, base, flows, canShare, surv);
  let passes = 0;
  const key = (c) => { try { return JSON.stringify(c); } catch (e) { return ''; } };
  while (canResim && passes < 8) {
    const nextSurv = cur.survCtx;
    if (key(nextSurv) === key(surv) && !(canShare && cur.newGifts > 0)) break;
    passes++;
    flows = cur.flows; surv = nextSurv;
    const p2 = opts.rerun.p(flows.p, surv.p), s2 = opts.rerun.s(flows.s, surv.s);
    cur = _mergeHouseholdOnce(p2, s2, opts, base, flows, canShare, surv);
  }
  cur.out.summary.sharePasses = passes;
  cur.out.summary.shareResimulated = canShare;
  cur.out.summary.survivorResimulated = canResim && !!(cur.survCtx.p || cur.survCtx.s);
  return cur.out;
}
// One merge over a given pair of runs. `flows` are the gifts already fed
// into these runs (per person, by their own age: + received, - made);
// gifts found on top of them go into the returned `flows` for the next
// pass. `base` holds the un-shared runs for the "without sharing" figures.
function _mergeHouseholdOnce(pRows, sRun, opts, base, flowsIn, canResim, survIn) {
  const sRows = sRun.rows, diff = sRun.ageDiff, g = opts.simG;
  const flows = { p: Object.assign({}, flowsIn.p), s: Object.assign({}, flowsIn.s) };
  let newGifts = 0;
  const provKey = opts.provKey;
  const survivorPct = Math.max(0, Math.min(1, opts.survivorPct ?? 0.6));
  // N10 (2026-09-20): death is its own age, not "the projection ended".
  // null = never dies inside the horizon, which is the pre-N10 behaviour.
  const deathP = Number.isFinite(opts.deathAgeP) ? opts.deathAgeP : null;
  const deathS = Number.isFinite(opts.deathAgeS) ? opts.deathAgeS : null;
  // What the SURVIVOR spends once alone: a share of the couple's total, not
  // the share they carried while both were alive. Their own run already
  // applies their own share, so the uplift is the ratio between the two.
  const survivorRatio = Math.max(0, Math.min(1, opts.survivorRatio ?? 0.65));
  const shareP = Math.max(0, Math.min(1, opts.shareP ?? 0.5));
  const shareS = Math.max(0, Math.min(1, 1 - shareP));
  const pByAge = Object.fromEntries(pRows.map(r => [r.age, r]));
  const sByAge = Object.fromEntries(sRows.map(r => [r.age, r]));
  const pRa = pRows[0].age, pEnd = pRows[pRows.length-1].age;
  const sRa = sRows[0].age, sEnd = sRows[sRows.length-1].age;
  const firstP = Math.min(pRa, sRa - diff), lastP = Math.max(pEnd, sEnd - diff);
  const years = [];
  let inherited = null; // {tfsa, reg, nonreg, acb, emerg, from:'p'|'s', deathYearAge}
  // The deceased's own age-65 CPP/QPP entitlement in today's dollars (see
  // _survivorPublicPension's header). Read from that person's own inputs at
  // the moment of death and indexed to each payment year below -- NOT their
  // last projected payment, which carries both their deferral increase and
  // every year of indexation up to their death, and which is zero outright
  // for someone who died before starting.
  let survivorDb = 0, survivorOf = null, survivorQppBase65 = 0;
  // N14: what this pass discovers about the survivor, to be fed back into
  // that person's own run. Keyed by the SURVIVOR's own ages.
  const survCtx = { p: null, s: null };
  const ctxFor = (who) => survCtx[who] || (survCtx[who] = { pension: {}, other: {}, taxFree: {}, shareFrom: null });
  // What the previous pass already fed into the rows we are reading now, so
  // the amounts below are computed from the person's OWN figures and never
  // from a benefit this function put there itself.
  const fedIn = (who, age, kind) => {
    const c = survIn && survIn[who];
    const v = c && c[kind] && c[kind][age];
    return Number.isFinite(v) ? v : 0;
  };
  let cumTaxWith = 0, cumTaxNo = 0, cumSaving = 0, firstShortfallAge = null;
  // N4 sharing state (see the header comment): the pool of reinvested
  // splitting savings, and what each person has given the other
  // (compounded), which their household-view balance is shown net of.
  const shareOn = opts.shareEnabled !== false;
  let poolBal = 0, cumShared = 0, cumInhDraw = 0, cumInhTax = 0;
  for (let p = firstP; p <= lastP; p++) {
    const s = p + diff;
    const rp = pByAge[p] || null, rs = sByAge[s] || null;
    // Dead from the year AFTER the death age: you live through the year you
    // die in, and the estate passes at its end (the same convention the
    // single-person horizon uses).
    const goneP = deathP != null && p > deathP, goneS = deathS != null && s > deathS;
    const statP = goneP ? 'deceased' : rp ? 'retired' : (p < pRa ? 'working' : 'deceased');
    const statS = goneS ? 'deceased' : rs ? 'retired' : (s < sRa ? 'working' : 'deceased');
    // First year after a death: capture the inheritance + survivor pension once.
    if (statP === 'deceased' && !inherited && (pByAge[goneP ? deathP : pEnd] || pByAge[pEnd]) && statS !== 'deceased') { const d = pByAge[goneP ? deathP : pEnd] || pByAge[pEnd]; inherited = { tfsa: d.tfsaBalClose||0, reg: (d.lifBalClose||0)+(d.rrspBalClose||0), nonreg: d.nonregBalClose||0, acb: d.nonregACBClose ?? d.nonregACB ?? 0, emerg: d.emergBalClose||0, from: 'p' }; survivorDb = Math.round((d.db||0) * survivorPct); survivorQppBase65 = _qppEligible() ? _qppBase65() : 0; survivorOf = 's'; }
    if (statS === 'deceased' && !inherited && (sByAge[goneS ? deathS : sEnd] || sByAge[sEnd]) && statP !== 'deceased') { const d = sByAge[goneS ? deathS : sEnd] || sByAge[sEnd]; inherited = { tfsa: d.tfsaBalClose||0, reg: (d.lifBalClose||0)+(d.rrspBalClose||0), nonreg: d.nonregBalClose||0, acb: d.nonregACBClose ?? d.nonregACB ?? 0, emerg: d.emergBalClose||0, from: 's' }; survivorDb = Math.round((d.db||0) * survivorPct); survivorQppBase65 = _withPersonInputs(sRun.inputs || null, () => _qppEligible() ? _qppBase65() : 0); survivorOf = 'p'; }
    const y = { ageP: p, ageS: s, statP, statS, rp, rs, split: null, survivorDb: 0, inherited: null };
    // Per-person figures (taxable, tax after split, clawback, net).
    // nonregTax: the Non-Reg capital-gains and dividend/interest tax the
    // person's own row already paid (realistic Non-Reg mode) -- part of
    // "lifetime tax" everywhere else (_taxCostBreakdown), so it is carried
    // into the household totals too (2026-09-19, external review follow-up:
    // with splitting off, the household total now reconciles with the two
    // individual totals). Unaffected by the split.
    const person = (r, age, inputs) => r ? { age, inputs, settings: inputs ? inputs.settings : null, nonregTax: (r.nonregCapGainsTax||0) + (r.nonregDivIntTax||0), taxable: r.totalTaxable||0, taxFree: r.extraTaxFree||0, elig: _eligiblePensionIncome(age, r.db, r.lif, r.rrif), oas: r.oas||0, db: r.db||0, qpp: r.qpp||0, oasAmt: r.oas||0, lif: r.lif||0, rrif: r.rrif||0, tfsaDraw: r.tfsa||0, nonregDraw: r.nonreg||0, spend: r.totalSpend||0, shortfall: r.shortfall||0, cf: _rowCashFlow(r), bal: _rowTotalBal(r) } : null;
    let P = goneP ? null : person(rp, p, null), S = goneS ? null : person(rs, s, sRun.inputs || null);
    // N14: the survivor's benefits are computed here, as they always were,
    // but they are no longer ADDED to the merged year. They go into the
    // survivor context, which is fed back into that person's own run -- so
    // by the pass that matters the figures below are already inside P/S,
    // having arrived through the row like every other dollar. What is left
    // here is the discovery, and the display fields the Household view
    // reads (y.survivorDb / survivorPublic / survivorAllowance).
    const surv = survivorOf === 'p' ? P : survivorOf === 's' ? S : null;
    if (surv) {
      const ctx = ctxFor(survivorOf);
      const survAge = surv.age;
      // This person's OWN figures: what the previous pass fed in is taken
      // back out, so a benefit is never computed from itself.
      const ownQpp = Math.max(0, surv.qpp - fedIn(survivorOf, survAge, 'other'));
      const ownTaxable = surv.taxable - fedIn(survivorOf, survAge, 'pension') - fedIn(survivorOf, survAge, 'other');
      // The deceased's age-65 entitlement, indexed from the base year to
      // this payment year on the shared calendar -- the same indexation the
      // retirement pension itself gets, applied to the right base.
      const decAt65 = survivorQppBase65 * _indexFactorFor(p);
      const pub = _survivorPublicPension(decAt65, survAge, ownQpp, provKey, p);
      // Income-tested on income INCLUDING the survivor's pension but before
      // the Allowance itself, which is what the real test does.
      const alw = _oasAllowanceSurvivor(survAge, ownTaxable + survivorDb + pub, p);
      if (survivorDb > 0) ctx.pension[survAge] = survivorDb;
      if (pub > 0) ctx.other[survAge] = pub;
      if (alw > 0) ctx.taxFree[survAge] = alw;
      // Living alone costs more than half of living together: from this age
      // on, this person's share of the household budget is the survivor
      // ratio rather than the share they carried as a couple. Their own run
      // then funds it, deposits what is left, and reports a shortfall only
      // when there really is one.
      if (!ctx.shareFrom || survAge < ctx.shareFrom.age) ctx.shareFrom = { age: survAge, share: survivorRatio };
      y.survivorDb = survivorDb; y.survivorPublic = pub; y.survivorAllowance = alw;
    }
    let taxP = 0, taxS = 0, clawP = 0, clawS = 0, taxNo = 0;
    if (P && S) {
      // N21: pension income splitting is a Canadian return's relief (a
      // joint election on two T1s). Part XIII withholding has no equivalent,
      // so it is never offered to a non-resident household.
      const sp = (opts.splitEnabled && _currentResidency().key === 'resident') ? optimalPensionSplit(P, S, provKey) : null;
      if (sp) { y.split = sp; taxP = sp.p.fed + sp.p.prov; clawP = sp.p.claw; taxS = sp.s.fed + sp.s.prov; clawS = sp.s.claw; taxNo = sp.noSplit; }
      else { const a = _personTaxAfterSplit(P, 0, 0, 0), b = _personTaxAfterSplit(S, 0, 0, 0); taxP = a.fed + a.prov; clawP = a.claw; taxS = b.fed + b.prov; clawS = b.claw; taxNo = a.total + b.total; }
    } else if (P) { const a = _personTaxAfterSplit(P, 0, 0, 0); taxP = a.fed + a.prov; clawP = a.claw; taxNo = a.total; }
    else if (S) { const b = _personTaxAfterSplit(S, 0, 0, 0); taxS = b.fed + b.prov; clawS = b.claw; taxNo = b.total; }
    // Non-Reg taxes count toward the lifetime totals (taxWith / taxNo) but
    // not toward net income: the engine pays them out of the Non-Reg
    // account, not out of the year's income (same as _taxCostBreakdown vs.
    // a row's netInc).
    const nrTaxP = P ? P.nonregTax : 0, nrTaxS = S ? S.nonregTax : 0;
    taxNo += nrTaxP + nrTaxS;
    const taxWith = taxP + clawP + taxS + clawS + nrTaxP + nrTaxS;
    const saving = Math.max(0, taxNo - taxWith);
    cumTaxWith += taxWith; cumTaxNo += taxNo; cumSaving += saving;
    // ---- N4: cash-flow sharing ----
    // N14: read straight from the row. The survivor's extra spending used
    // to be added to this figure without ever being netted against the
    // surplus the same row had just deposited, which reported a shortfall
    // beside real surplus; it is now part of the budget that row funded.
    let sfP = P ? P.shortfall : 0, sfS = S ? S.shortfall : 0;
    if (surv) {
      // Display only: how much of what the survivor spends is the uplift
      // over the share they carried as a couple.
      const own = survivorOf === 'p' ? shareP : shareS;
      const extra = (own > 0 && survivorRatio > 0) ? Math.max(0, Math.round(surv.spend * (1 - own / survivorRatio))) : 0;
      if (extra > 0) y.survivorExtraSpend = extra;
    }
    const share = { pToS: 0, sToP: 0, poolToP: 0, poolToS: 0, inhDraw: 0, inhTax: 0, inhFrom: null };
    let inhTaxP = 0, inhTaxS = 0;
    if (shareOn) {
      // 1. same-year surplus of one covers the other's shortfall. The gifts
      //    already in these runs show as the receiver's external inflow;
      //    any shortfall or surplus left on top of them is a NEW gift,
      //    queued for the next re-simulation (only when the caller can
      //    re-run; see mergeHousehold).
      share.pToS = S ? Math.max(0, flows.s[s] || 0) : 0;
      share.sToP = P ? Math.max(0, flows.p[p] || 0) : 0;
      if (canResim) {
        const availP = P ? Math.max(0, P.cf) : 0, availS = S ? Math.max(0, S.cf) : 0;
        const giftPS = Math.round(Math.min(availP, sfS)), giftSP = Math.round(Math.min(availS, sfP));
        if (giftPS >= 2) { flows.p[p] = (flows.p[p] || 0) - giftPS; flows.s[s] = (flows.s[s] || 0) + giftPS; newGifts += giftPS; sfS -= giftPS; share.pToS += giftPS; }
        if (giftSP >= 2) { flows.s[s] = (flows.s[s] || 0) - giftSP; flows.p[p] = (flows.p[p] || 0) + giftSP; newGifts += giftSP; sfP -= giftSP; share.sToP += giftSP; }
      }
      // 2. the splitting saving is reinvested in a household pool, which covers what is left.
      poolBal += saving;
      share.poolToP = Math.round(Math.min(poolBal, sfP)); poolBal -= share.poolToP; sfP -= share.poolToP;
      share.poolToS = Math.round(Math.min(poolBal, sfS)); poolBal -= share.poolToS; sfS -= share.poolToS;
      // 3. the survivor draws on the inheritance: tax-free money first, then
      //    Non-Reg (half the gain at the marginal rate), then registered
      //    (grossed up; the tax lands in the survivor's year).
      if (inherited && survivorOf) {
        const who = survivorOf === 'p' ? P : S;
        let need = survivorOf === 'p' ? sfP : sfS;
        if (who && need > 0) {
          const inh = Object.assign({}, inherited);
          let drawn = 0, tax = 0;
          const takeFree = Math.min(need, inh.tfsa + inh.emerg);
          if (takeFree > 0) { const fromTfsa = Math.min(takeFree, inh.tfsa); inh.tfsa -= fromTfsa; inh.emerg -= (takeFree - fromTfsa); drawn += takeFree; need -= takeFree; }
          if (need > 0 && inh.nonreg > 0) {
            const gainFrac = inh.nonreg > 0 ? Math.max(0, (inh.nonreg - inh.acb) / inh.nonreg) : 0;
            const marginal = _withPersonInputs(who.inputs || null, () => _calcTaxDetail(who.taxable, who.age, who.elig, who.oas || 0).marginal) || 0;
            const perDollarTax = gainFrac * CAP_GAINS_INCLUSION_RATE * marginal;
            const gross = Math.min(inh.nonreg, need / Math.max(1e-9, 1 - perDollarTax));
            const t_ = Math.round(gross * perDollarTax);
            inh.acb = Math.max(0, inh.acb * (1 - gross / inh.nonreg)); inh.nonreg -= gross;
            drawn += gross; tax += t_; need -= Math.max(0, gross - t_);
          }
          if (need > 0 && inh.reg > 0) {
            const marginal = _withPersonInputs(who.inputs || null, () => _calcTaxDetail(who.taxable, who.age, who.elig, who.oas || 0).marginal) || 0;
            const gross = Math.min(inh.reg, need / Math.max(1e-9, 1 - marginal));
            const t_ = _withPersonInputs(who.inputs || null, () => _incrementalTaxOn(who.taxable, gross, who.age, who.elig));
            inh.reg -= gross; drawn += gross; tax += t_; need -= Math.max(0, gross - t_);
          }
          inherited = inh;
          share.inhDraw = Math.round(drawn); share.inhTax = Math.round(tax); share.inhFrom = survivorOf;
          if (survivorOf === 'p') { sfP = Math.max(0, Math.round(need)); inhTaxP = share.inhTax; } else { sfS = Math.max(0, Math.round(need)); inhTaxS = share.inhTax; }
        }
      }
      cumShared += share.pToS + share.sToP + share.poolToP + share.poolToS + share.inhDraw;
      cumInhDraw += share.inhDraw; cumInhTax += share.inhTax;
    }
    // Inherited balances grow (net of any draw above); so does the pool.
    if (inherited) { inherited = Object.assign({}, inherited, { tfsa: inherited.tfsa*(1+g), reg: inherited.reg*(1+g), nonreg: inherited.nonreg*(1+_SIM_GNREG), emerg: inherited.emerg*(1+_SIM_GEMERG) }); y.inherited = inherited; }
    // Tax-free income (today: the OAS Allowance for the Survivor) is spendable
    // cash that was never taxed, so it joins net income here rather than in
    // `taxable`, which drives the tax and the pension split above.
    const netP = P ? P.taxable - taxP - clawP - inhTaxP + P.taxFree : 0, netS = S ? S.taxable - taxS - clawS - inhTaxS + S.taxFree : 0;
    const shortfall = sfP + sfS;
    if (shortfall > 0 && firstShortfallAge == null) firstShortfallAge = p;
    cumTaxWith += inhTaxP + inhTaxS; cumTaxNo += inhTaxP + inhTaxS;
    Object.assign(y, {
      P, S, taxP: taxP + inhTaxP, taxS: taxS + inhTaxS, clawP, clawS, nrTaxP, nrTaxS, taxNo: taxNo + inhTaxP + inhTaxS, taxWith: taxWith + inhTaxP + inhTaxS, saving, netP, netS,
      netHousehold: netP + netS, spend: (P ? P.spend : 0) + (S ? S.spend : 0), shortfall, shortfallRaw: (() => { const rp = base.pRows.find(r => r.age === p), rs = base.sRows.find(r => r.age === s); return ((rp && rp.shortfall) || 0) + ((rs && rs.shortfall) || 0); })(),
      share, pool: poolBal,
      // Gifts are inside each person's own cf now (the giver deposited
      // less; the receiver had the cash); pool and inheritance draws are not.
      cashFlow: (P ? P.cf : 0) + (S ? S.cf : 0) + saving - share.poolToP - share.poolToS - share.inhDraw,
      balP: P ? P.bal : 0, balS: S ? S.bal : 0, balInherited: inherited ? inherited.tfsa + inherited.reg + inherited.nonreg + inherited.emerg : 0,
      year: _oasProjectionYear(p),
    });
    years.push(y);
    poolBal *= (1 + g);
  }
  // Estate at the last household year.
  let estate;
  const pEst = computeEstate(pRows), sEst = sRun.estate || _withPersonInputs(sRun.inputs || null, () => computeEstate(sRows));
  if (pEnd === sEnd - diff) {
    estate = { net: pEst.net + sEst.net, p: pEst.net, s: sEst.net, inherited: 0, inheritedDeathTax: 0, survivor: null, age: pEnd };
  } else {
    const survivorIsP = pEnd > sEnd - diff;
    const sv = survivorIsP ? pByAge[pEnd] : sByAge[sEnd];
    const own = survivorIsP ? pEst : sEst;
    const inh = inherited || { tfsa: 0, reg: 0, nonreg: 0, acb: 0, emerg: 0 };
    const survAge = survivorIsP ? pEnd : sEnd;
    const base = (sv.totalTaxable||0) + survivorDb;
    const elig = _eligiblePensionIncome(survAge, (sv.db||0) + survivorDb, sv.lif, sv.rrif);
    const ownReg = (sv.lifBalClose||0) + (sv.rrspBalClose||0);
    const gain = Math.max(0, inh.nonreg - inh.acb);
    // Survivor-side tax in the SURVIVOR's own indexation context (H2). The
    // inherited Non-Reg gain is taxed at the marginal rate reached once the
    // survivor's own registered balance is already stacked on the return.
    const { regTax, nonregTax } = _withPersonInputs(survivorIsP ? null : (sRun.inputs || null), () => ({
      regTax: _incrementalTaxOn(base + ownReg, inh.reg, survAge, elig),
      nonregTax: Math.round(gain * CAP_GAINS_INCLUSION_RATE * _calcTaxDetail(base + ownReg, survAge, elig).marginal),
    }));
    const inheritedNet = Math.round(inh.tfsa + inh.emerg + (inh.reg - regTax) + (inh.nonreg - nonregTax));
    estate = { net: own.net + inheritedNet, p: survivorIsP ? own.net : 0, s: survivorIsP ? 0 : own.net, inherited: inheritedNet, inheritedDeathTax: regTax + nonregTax, survivor: survivorIsP ? 'p' : 's', age: pEnd > sEnd - diff ? pEnd : sEnd - diff };
  }
  // N4: the pool (reinvested splitting savings) joins the estate as cash.
  // Gifts need no adjustment here: the estates above come from the
  // re-simulated runs, in which the giver really has less.
  if (shareOn) {
    const pool = Math.round(poolBal / (1 + g));
    estate = Object.assign({}, estate, { pool, net: estate.net + pool });
  }
  const firstBoth = years.find(y => y.P && y.S);
  const summary = {
    lifetimeTaxWithSplit: Math.round(cumTaxWith), lifetimeTaxNoSplit: Math.round(cumTaxNo), splitSaving: Math.round(cumSaving),
    firstShortfallAge, guaranteedAtStart: firstBoth ? (firstBoth.P.db + firstBoth.P.qpp + firstBoth.P.oasAmt + firstBoth.S.db + firstBoth.S.qpp + firstBoth.S.oasAmt) : null,
    firstBothAge: firstBoth ? firstBoth.ageP : null, lastAge: lastP, survivor: estate.survivor, ageDiff: diff,
    shareEnabled: shareOn, sharedTotal: Math.round(cumShared), inheritedDrawn: Math.round(cumInhDraw), inheritedDrawTax: Math.round(cumInhTax), poolEnd: shareOn ? Math.round(poolBal / (1 + g)) : 0,
    // "Without sharing": the first shortfall of the un-shared runs.
    firstShortfallAgeRaw: (() => {
      const bp = Object.fromEntries(base.pRows.map(r => [r.age, r])), bs = Object.fromEntries(base.sRows.map(r => [r.age, r]));
      for (let a = firstP; a <= lastP; a++) { const rp = bp[a], rs = bs[a + diff]; if (((rp && rp.shortfall) || 0) + ((rs && rs.shortfall) || 0) > 0) return a; }
      return null;
    })(),
  };
  return { out: { years, summary, estate, pRows, sRows, flows, sRun }, flows, newGifts, survCtx };
}
