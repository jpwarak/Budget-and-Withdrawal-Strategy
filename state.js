// ════════════════════════════════════════════════════════════════════════
// state.js -- the unified app-state persistence layer, physically split out
// of withdrawal_strategy_JP.html (Priority 16, Phase 3).
//
// This is the whole "Unified app-state storage" mechanism, moved verbatim:
// one versioned localStorage key (plannerState), an in-memory cache
// (_appState), read/write through _stateGet/_stateSet/_stateSetMany, and
// the one-time migration off the ~20 old top-level keys
// (_migrateLegacyStorageIfNeeded). None of it touches the DOM -- it only
// ever reads/writes localStorage and its own in-memory object -- so, like
// engine.js before it, it moved with zero behavior change: same mechanism
// Phase 2 already proved (a plain <script src>, no build step, ordinary
// globals shared with the later inline <script> via the page's one shared
// lexical scope).
//
// What did NOT move: every function that reads/writes a *specific* piece of
// state via this layer (_saveRetState(), _loadAccState(), the Budget tab's
// own save/load, etc.) stays in the main file, since those all read the
// live DOM (document.getElementById(...).value and friends) as part of
// building what they persist -- exactly the same "DOM access keeps it in
// the main file" line Phase 2 drew for the calculation engine's UI cluster.
// ════════════════════════════════════════════════════════════════════════

// ── Unified app-state storage ───────────────────────────────────────────────
// Everything this file used to persist as 20+ independent top-level
// localStorage keys (retirement settings, the Accumulation/Budget blobs,
// nav prefs) now lives under this ONE versioned key, namespaced by area
// ('ret'/'acc'/'budget'/'nav'). One key means one place to look, and a
// future export/reset-all feature is just "read/replace this one key"
// instead of gathering a dozen keys by hand.
//
// _appState is an in-memory cache of the parsed blob: every _stateGet/
// _stateSet reads from and writes to it directly, so a burst of saves in
// one tick doesn't reparse/re-stringify the whole thing each time. It's
// small JSON (settings and form inputs, not the big precomputed data
// tables elsewhere in this file), so re-serializing on every _stateSet is
// cheap.
const APP_STATE_KEY = 'plannerState';

const APP_STATE_VERSION = 1;

let _appState = null;

function _stateLoad() {
  let raw = null;
  try {
    raw = localStorage.getItem(APP_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch(e) { /* corrupt/unavailable — handled just below */ }
  // A present-but-unparseable blob used to be silently replaced on the very
  // first _stateSet() of the session -- every saved input gone, no trace.
  // Since 2026-09-17 (2026-09-16 review, A12) the raw text is stashed under
  // APP_STATE_KEY + '_corrupt' first (one copy, overwritten each time) and
  // the app is told, so the data can still be recovered by hand.
  if (raw) {
    try { localStorage.setItem(APP_STATE_KEY + '_corrupt', raw); } catch(e) { /* nothing more to do */ }
    if (typeof _reportError === 'function') _reportError('state.corrupt');
  }
  return { v: APP_STATE_VERSION, ret: {}, acc: {}, budget: {}, nav: {} };
}

// Reports whether the write actually landed (true) or was silently
// swallowed (false, e.g. storage full/unavailable/disabled). Most callers
// (_stateSet/_stateSetMany below) ignore the return value -- a failed
// regular save just means "try again next edit" -- but
// _migrateLegacyStorageIfNeeded() (below) checks it before deleting the
// legacy keys it's migrating FROM, so a failed migration write can't take
// both the old and new copies of the data down with it.
let _statePersistFailedOnce = false;
// While frozen, every write stays in the in-memory _appState and nothing
// reaches localStorage (N12, 2026-09-20). The version-diff replays a saved
// plan through the real DOM loaders to measure it, and those DOM writes fire
// the ordinary input/change handlers -- which would otherwise persist a plan
// the user never chose. One guard here rather than in every handler.
let _stateFrozen = false;
function _stateFreeze(on) { _stateFrozen = !!on; }
function _statePersist() {
  if (_stateFrozen) return true;
  try { localStorage.setItem(APP_STATE_KEY, JSON.stringify(_appState)); _statePersistFailedOnce = false; return true; }
  catch(e) {
    // Storage full / disabled / private mode. Was completely silent: every
    // edit looked saved and vanished on reload. Tell the user once per
    // failure streak (2026-09-17, 2026-09-16 review, A12).
    if (!_statePersistFailedOnce && typeof _reportError === 'function') _reportError('state.persistFailed', e);
    _statePersistFailedOnce = true;
    return false;
  }
}

// fallback is returned for undefined/null/'' — the same "nothing saved yet"
// test every call site here used against raw localStorage.getItem() before.
function _stateGet(area, key, fallback) {
  if (!_appState) _appState = _stateLoad();
  const v = _appState[area] ? _appState[area][key] : undefined;
  return (v === undefined || v === null || v === '') ? fallback : v;
}

function _stateSet(area, key, value) {
  if (!_appState) _appState = _stateLoad();
  if (!_appState[area]) _appState[area] = {};
  _appState[area][key] = value;
  _statePersist();
}

// Bulk variant: set several keys in one area with ONE localStorage write
// instead of N separate _stateSet calls each re-serializing the whole blob
// — used by _saveRetState() below, which used to be N independent setItem
// calls.
function _stateSetMany(area, obj) {
  if (!_appState) _appState = _stateLoad();
  if (!_appState[area]) _appState[area] = {};
  Object.assign(_appState[area], obj);
  _statePersist();
}

// One-time migration from the ~20 old top-level keys into the unified
// object above. Runs once, before anything else reads saved state (called
// as the very first line of the restore IIFE below, which itself runs
// synchronously before the later Budget/tab restore in DOMContentLoaded —
// so by the time any of those run, migration has already happened). A
// browser that already has the unified key (already migrated, or a
// genuinely fresh install that's never touched any of the old keys) is a
// no-op. Only removes the top-level keys it actually consumes — NOT the
// even-older per-field/legacy fallback keys some functions still read on
// their own (ACC_PERSIST_IDS' old per-field keys, budgetData_pre/_post,
// budgetCollapsed_pre) — those stay exactly as they were, their own
// separate documented fallback tier, untouched by this migration.
function _migrateLegacyStorageIfNeeded() {
  if (localStorage.getItem(APP_STATE_KEY)) return;
  const s = { v: APP_STATE_VERSION, ret: {}, acc: {}, budget: {}, nav: {} };
  let touched = false;
  const moveStr = (area, key, oldKey) => {
    const v = localStorage.getItem(oldKey);
    if (v != null) { s[area][key] = v; touched = true; }
  };
  moveStr('ret','tab','retTab');
  moveStr('ret','age','retAge');
  moveStr('ret','spendMode','retSpendMode');
  moveStr('ret','qppStart','retQppStart');
  moveStr('ret','oasStart','retOasStart');
  moveStr('ret','growthRate','retGrowthRate');
  moveStr('ret','halfUnlock','retHalfUnlock');
  moveStr('ret','nrLifUnlock','retPhUnlockMode');
  moveStr('ret','cpiRate','retCpiRate');
  ['tgt60','tgt65','tgt70','tgt75','tgt80'].forEach(id => moveStr('ret', id, 'ret_'+id));
  moveStr('ret','useDBPension','useDBPension');
  moveStr('ret','nonregRealisticTax','nonregRealisticTax');

  const accRaw = localStorage.getItem('accState');
  if (accRaw) { try { const p = JSON.parse(accRaw); if (p && typeof p==='object') { s.acc.data = p; touched = true; } } catch(e) {} }

  const budRaw = localStorage.getItem('budgetData');
  if (budRaw) { try { const p = JSON.parse(budRaw); if (p && typeof p==='object') { s.budget.data = p; touched = true; } } catch(e) {} }
  moveStr('budget','incomeAge','budgetIncomeAge');
  const collRaw = localStorage.getItem('budgetCollapsed');
  if (collRaw) { try { const p = JSON.parse(collRaw); if (Array.isArray(p)) { s.budget.collapsed = p; touched = true; } } catch(e) {} }

  moveStr('nav','activeTab','activeTab');
  moveStr('nav','budgetSubTab','budgetSubTab');

  if (!touched) return; // nothing old to migrate (first-ever visit) — _stateSet will create the key on first real save
  _appState = s;
  // The legacy keys are only ever removed once this write is confirmed to
  // have actually landed (storage full, private-browsing storage disabled,
  // quota already exhausted, etc. all count as a failure) -- on failure,
  // migration is simply left to retry on the next visit: the old keys are
  // still there, untouched, and APP_STATE_KEY still doesn't exist, so
  // _migrateLegacyStorageIfNeeded() will attempt the exact same migration
  // again next time this runs.
  if (!_statePersist()) return;
  ['retTab','retAge','retSpendMode','retQppStart','retOasStart','retGrowthRate',
   'retHalfUnlock','retPhUnlockMode','retCpiRate',
   'ret_tgt60','ret_tgt65','ret_tgt70','ret_tgt75','ret_tgt80',
   'useDBPension','nonregRealisticTax','accState','budgetData','budgetIncomeAge',
   'budgetCollapsed','activeTab','budgetSubTab'].forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });
}
