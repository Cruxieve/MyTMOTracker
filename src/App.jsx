import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Home, DollarSign, Users, Settings as SettingsIcon, Plus, X,
  Search, Phone, Mail, Edit2, Trash2, Calendar, TrendingUp, LogOut,
  ChevronRight, ChevronLeft, ChevronDown, Smartphone, ShieldCheck, Upload, ExternalLink, FileText,
  Wifi, Watch, Tablet, CreditCard, Package, Zap, Gift, Check, Minus, ArrowUpCircle, UserPlus, Maximize2, Shield
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, ResponsiveContainer, Tooltip, CartesianGrid
} from 'recharts';

/* ------------------------------------------------------------------------
 * window.storage shim — only needed because this app was originally built
 * for Claude's artifact sandbox, which injects a window.storage API that
 * doesn't exist in a normal browser. This recreates the same get/set/delete
 * interface on top of localStorage, so every call site elsewhere in the
 * app works unchanged. Safe to delete this block if window.storage is ever
 * provided natively again.
 * ------------------------------------------------------------------------ */
if (typeof window !== 'undefined' && !window.storage) {
  const prefix = 'tmo-tracker:';
  window.storage = {
    async get(key) {
      const raw = localStorage.getItem(prefix + key);
      if (raw == null) throw new Error('not found');
      return { key, value: raw };
    },
    async set(key, value) {
      localStorage.setItem(prefix + key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem(prefix + key);
      return { key, deleted: true };
    },
    async list(searchPrefix) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const bare = k.slice(prefix.length);
          if (!searchPrefix || bare.startsWith(searchPrefix)) keys.push(bare);
        }
      }
      return { keys };
    },
  };
}

/* ---------------------------------- data ---------------------------------- */

// calcType: 'percentMRC' = rate x monthly plan charge, 'percentPrice' = rate x sale price,
// 'flat' = fixed $ per unit (qty multiplies), 'manual' = rep enters the $ amount directly

/* ============================================================
 *  TEAM CONFIG — shared Monthly Goals & SPIFFs, read by every device.
 *  This is a narrow, deliberately low-stakes sync: it holds ONLY goals
 *  and SPIFFs (target numbers, category names, dollar amounts) — never
 *  customer data, never sales. Sales and customers stay fully local,
 *  exactly as before.
 *
 *  Paste your Supabase project's values here. Run team-config-setup.sql
 *  in your Supabase project first — same project as before is fine.
 * ============================================================ */
const SUPABASE_URL = 'PASTE_YOUR_PROJECT_URL_HERE';
const SUPABASE_ANON_KEY = 'PASTE_YOUR_ANON_PUBLIC_KEY_HERE';
const SUPABASE_READY = SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 20;

function cleanUrl(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

async function fetchTeamConfig() {
  const url = `${cleanUrl(SUPABASE_URL)}/rest/v1/team_config?id=eq.1&select=goals,spiffs,passphrase,updated_at`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error(`Couldn't reach team config (${res.status})`);
  const rows = await res.json();
  return rows?.[0] || null;
}

async function publishTeamConfig(goals, spiffs) {
  const url = `${cleanUrl(SUPABASE_URL)}/rest/v1/team_config?id=eq.1`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ goals, spiffs }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(t || `Couldn't publish (${res.status})`);
  }
  return true;
}

const DEFAULT_CATEGORIES = [
  { name: 'Postpaid Rate Plan', calcType: 'percentMRC', rate: 0.5 },
  { name: 'Voice Line', calcType: 'percentMRC', rate: 0.5, hasQty: true },
  { name: 'Watch Line', calcType: 'percentMRC', rate: 0.5, hasQty: true },
  { name: 'Tablet Line', calcType: 'percentMRC', rate: 0.5, hasQty: true },
  { name: 'Home Internet', calcType: 'percentMRC', rate: 0.5 },
  { name: 'Fiber Activation', calcType: 'percentMRC', rate: 0.5 },
  { name: 'Prepaid Plan', calcType: 'percentPrice', rate: 0.15, hasQty: true },
  { name: 'Accessories', calcType: 'percentPrice', rate: 0.15 },
  { name: 'Protection 360', calcType: 'flat', rate: 8 },
  { name: 'BYOD Protection', calcType: 'flat', rate: 5 },
  { name: 'Upgrade', calcType: 'flat', rate: 5 },
  { name: 'Visa', calcType: 'flat', rate: 10, noQty: true },
];

// Categories that shouldn't appear in the transaction picker (kept out of the
// flow so it stays to concrete, rate-driven sales).
const HIDDEN_IN_PICKER = ['Monthly Spiff', 'Other'];

// Normalizes old string-only categories (from before rates existed) into the new object shape
// Category names that changed after they were already in use — old name -> new name.
// Kept as a table so future renames (like this one) don't need bespoke logic.
const CATEGORY_RENAMES = {
  'Accessory': 'Accessories',
  'Protection <360>': 'Protection 360',
  'Visa Application': 'Visa',
};

function migrateCategories(list) {
  if (!Array.isArray(list)) return DEFAULT_CATEGORIES;
  const saved = list.map(c => (typeof c === 'string' ? { name: c, calcType: 'manual', rate: 0 } : c))
    // Rename in place first, so the "already present" check below recognizes
    // a renamed category instead of treating it as missing and duplicating it.
    .map(c => {
      const renamed = CATEGORY_RENAMES[c.name];
      if (!renamed) return c;
      // Accessory's old shape also had a per-unit quantity that no longer
      // applies — Protection 360's quantity stepper is unrelated and unaffected.
      return renamed === 'Accessories' ? { ...c, name: renamed, hasQty: false } : { ...c, name: renamed };
    });
  // Saved lists predate later additions, so fold in any new built-in categories,
  // keeping each one next to its default neighbours rather than tacked on the end.
  const merged = [...saved];
  DEFAULT_CATEGORIES.forEach((def, i) => {
    if (merged.some(c => c.name === def.name)) return;
    const prev = DEFAULT_CATEGORIES[i - 1];
    const at = prev ? merged.findIndex(c => c.name === prev.name) : -1;
    if (at >= 0) merged.splice(at + 1, 0, def);
    else merged.push(def);
  });
  // Accessory commission is now the total sale amount entered × rate, not a
  // per-unit price × quantity — correct any category saved under the old shape.
  const fixed = merged.map(c => (c.name === 'Accessories' && c.hasQty ? { ...c, hasQty: false } : c));
  // Belt-and-suspenders: if an earlier load already created a duplicate before
  // this fix existed, collapse back down to one entry per name.
  const seen = new Set();
  return fixed.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

// "Accessory" was renamed to "Accessories" — fix up anything saved under the
// old name so past transactions, goals, and SPIFFs still match correctly.
// "Accessory" was renamed to "Accessories" and "Protection <360>" to "Protection
// 360" — fix up anything saved under an old name so past transactions, goals,
// and SPIFFs still match correctly. Uses CATEGORY_RENAMES, so future renames
// just need a table entry, not new migration logic.
function renameSavedCategories(commissionsList, goalsObj, spiffsList) {
  let changed = false;
  const fix = n => (CATEGORY_RENAMES[n] ? CATEGORY_RENAMES[n] : n);

  const nextCommissions = commissionsList.map(c => {
    if (Array.isArray(c.items) && c.items.some(it => CATEGORY_RENAMES[it.category])) {
      changed = true;
      return { ...c, items: c.items.map(it => (CATEGORY_RENAMES[it.category] ? { ...it, category: fix(it.category) } : it)) };
    }
    if (CATEGORY_RENAMES[c.category]) { changed = true; return { ...c, category: fix(c.category) }; }
    return c;
  });

  const nextGoals = {};
  for (const month in goalsObj) {
    const entry = goalsObj[month] || {};
    const fixList = list => (list || []).map(g => {
      const cats = (g.categoryNames || []).map(fix);
      const base = g.baseCategoryNames ? g.baseCategoryNames.map(fix) : g.baseCategoryNames;
      if (JSON.stringify(cats) !== JSON.stringify(g.categoryNames) || JSON.stringify(base) !== JSON.stringify(g.baseCategoryNames)) changed = true;
      return { ...g, categoryNames: cats, ...(g.baseCategoryNames ? { baseCategoryNames: base } : {}) };
    });
    nextGoals[month] = { fullTime: fixList(entry.fullTime), partTime: fixList(entry.partTime) };
  }

  const nextSpiffs = spiffsList.map(s => {
    if (CATEGORY_RENAMES[s.categoryName]) { changed = true; return { ...s, categoryName: fix(s.categoryName) }; }
    return s;
  });

  return { changed, commissions: nextCommissions, goals: nextGoals, spiffs: nextSpiffs };
}

/* ---------------- SPIFFs ----------------
 * A SPIFF is a bonus paid on top of standard commission — for selling a specific
 * category outright, or a specific named plan within a category. Reps set these
 * up themselves since they change month to month; nothing is hardcoded here.
 */

// Categories with named plans a SPIFF can target specifically (vs. the whole category).
function plansForCategory(categoryName) {
  if (categoryName === 'Postpaid Rate Plan') return PLANS.map(p => p.name);
  if (categoryName === 'Home Internet') return HOME_INTERNET_PLANS.map(p => p.name);
  if (categoryName === 'Fiber Activation') return FIBER_PLANS.map(p => p.name);
  if (categoryName === 'Watch Line') return WATCH_PLANS.map(p => p.name);
  if (categoryName === 'Tablet Line') return TABLET_PLANS.map(p => p.name);
  return null;
}

// SPIFFs active for a given category (+ plan, if the item has one). A SPIFF with no
// planName applies to the whole category; one with a planName only matches that plan.
function activeSpiffsFor(spiffs, categoryName, planName) {
  if (!Array.isArray(spiffs) || !categoryName) return [];
  return spiffs.filter(s => {
    if (!s.active || s.categoryName !== categoryName) return false;
    if (s.planName) return s.planName === planName;
    return true;
  });
}

function spiffTotalFor(spiffs, categoryName, planName) {
  return activeSpiffsFor(spiffs, categoryName, planName).reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
}

// Same "how many units" logic computeCommission uses internally, so a SPIFF scales
// with quantity exactly like the commission itself does (e.g. 3 BYOD sold = 3x the SPIFF).
function effectiveUnits(cat, draft) {
  if (!cat) return 1;
  if (cat.calcType === 'flat') return cat.noQty ? 1 : (Number(draft.qty) || 1);
  if (cat.hasQty) return Number(draft.qty) || 1;
  return 1;
}

/* ---------------- Monthly goals ---------------- *
 * goals shape: { [monthKey]: { fullTime: [{id, categoryName, target, label}], partTime: [...] } }
 * Goals are set by month, but a month with nothing configured falls back to the
 * most recent earlier month that has goals — so the admin doesn't have to
 * re-enter the same numbers every month unless something actually changed.
 */
function goalsForMonth(goals, monthKey, employmentType) {
  const key = employmentType === 'partTime' ? 'partTime' : 'fullTime';
  if (!goals) return { list: [], sourceMonth: null };
  if (goals[monthKey] && (goals[monthKey][key] || []).length) {
    return { list: goals[monthKey][key], sourceMonth: monthKey };
  }
  const priorKeys = Object.keys(goals)
    .filter(k => k <= monthKey && (goals[k][key] || []).length)
    .sort()
    .reverse();
  if (priorKeys.length) return { list: goals[priorKeys[0]][key], sourceMonth: priorKeys[0] };
  return { list: [], sourceMonth: null };
}

// Flattens a commission entry into its line items, matching the same legacy
// single-item fallback used elsewhere (SaleRow, the Sales tab, etc.).
function itemsOf(entry) {
  if (Array.isArray(entry.items) && entry.items.length) return entry.items;
  if (!entry.category) return [];
  return [{ category: entry.category, qty: entry.qty }];
}

// A goal is its own named metric (e.g. "Consumer Voice") that can pull from several
// categories at once — a Postpaid line, a Voice Line, and a Prepaid Plan sold in the
// same transaction can all count toward the same goal total.
// A transaction "wins" for a BYOD line if it contains something that actually
// counts toward the goal being measured — BYOD Protection for an attach-rate
// goal, an Essential accessory for a revenue goal, etc. Accessory items only
// count as a win if flagged Essential, same rule as everywhere else.
function transactionHasWin(items, winCategories) {
  const set = new Set(winCategories || []);
  return items.some(it => {
    if (!set.has(it.category)) return false;
    if (it.category === 'Accessories' && !it.isEssential) return false;
    return true;
  });
}

function unitsSoldForGoal(commissions, categoryNames, monthKey, opts) {
  const names = categoryNames || [];
  const plainSet = new Set(names.filter(n => !VIRTUAL_GOAL_TAGS[n]));
  const virtualMatchers = names.filter(n => VIRTUAL_GOAL_TAGS[n]).map(n => VIRTUAL_GOAL_TAGS[n].match);
  const excludeNoOpportunity = opts && opts.excludeNoOpportunity;
  const winCategories = (opts && opts.winCategories) || [];
  let total = 0;
  for (const c of commissions) {
    if ((c.date || '').slice(0, 7) !== monthKey) continue;
    const items = itemsOf(c);
    // A BYOD line can't take Protection 360, and doesn't come with a new
    // device to case up — it's only a real opportunity if something that
    // actually counts toward this goal was attached in the same transaction.
    const hasWin = transactionHasWin(items, winCategories);
    for (const it of items) {
      if (it.category === 'Visa' && !it.isPriority) continue; // every Visa gets paid, but only priority customers count toward the goal
      if (excludeNoOpportunity) {
        if (it.alreadyProtected) continue; // upgrade — line already protected
        if (it.category === 'Voice Line' && it.isBYOD && !hasWin) continue; // BYOD, nothing attached
      }
      if (plainSet.has(it.category) || virtualMatchers.some(fn => fn(it))) {
        total += Number(it.qty) || 1;
      }
    }
  }
  return total;
}

// Normalizes a goal to always have categoryNames (an array), for anything saved
// under the earlier single-category shape.
function goalCategoryNames(g) {
  if (Array.isArray(g.categoryNames)) return g.categoryNames;
  if (g.categoryName) return [g.categoryName];
  return [];
}

// Percentage goals (attach rates) divide one set of categories by another —
// e.g. Protection 360 + BYOD Protection sold, out of Postpaid Rate Plan lines
// sold. Unit goals just count straight up.
// Sums dollar sale-price revenue (not commission) for matching categories in a
// given month. Accessory items only count if flagged "Essential" — not every
// accessory sold counts toward an essential-accessory revenue goal.
function revenueForGoal(commissions, categoryNames, monthKey) {
  const names = new Set(categoryNames || []);
  let total = 0;
  for (const c of commissions) {
    if ((c.date || '').slice(0, 7) !== monthKey) continue;
    for (const it of itemsOf(c)) {
      if (!names.has(it.category)) continue;
      if (it.category === 'Accessories' && !it.isEssential) continue;
      total += (Number(it.baseValue) || 0) * (Number(it.qty) || 1);
    }
  }
  return total;
}

function computeGoalProgress(g, commissions, monthKey) {
  const target = Number(g.target) || 0;
  if (g.goalType === 'percent') {
    const opts = { excludeNoOpportunity: true, winCategories: goalCategoryNames(g) };
    const numerator = unitsSoldForGoal(commissions, goalCategoryNames(g), monthKey, opts);
    const denominator = unitsSoldForGoal(commissions, g.baseCategoryNames || [], monthKey, opts);
    const achieved = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
    const pct = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;
    const met = target > 0 && denominator > 0 && achieved >= target;
    return { achieved, target, pct, met, isPercent: true, numerator, denominator };
  }
  if (g.goalType === 'revenuePerUnit') {
    const revenue = revenueForGoal(commissions, goalCategoryNames(g), monthKey);
    const opts = { excludeNoOpportunity: true, winCategories: goalCategoryNames(g) };
    const units = unitsSoldForGoal(commissions, g.baseCategoryNames || [], monthKey, opts);
    const achieved = units > 0 ? Math.round((revenue / units) * 100) / 100 : 0;
    const pct = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;
    const met = target > 0 && units > 0 && achieved >= target;
    return { achieved, target, pct, met, isRevenuePerUnit: true, revenue, units };
  }
  const achieved = unitsSoldForGoal(commissions, goalCategoryNames(g), monthKey);
  const pct = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;
  const met = target > 0 && achieved >= target;
  return { achieved, target, pct, met, isPercent: false };
}

function fmtMoneyPlain(n) {
  return `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
}

function calcLabel(cat) {
  if (!cat) return '';
  if (cat.calcType === 'percentMRC') return `${Math.round(cat.rate * 100)}% of monthly plan charge`;
  if (cat.calcType === 'percentPrice') return `${Math.round(cat.rate * 100)}% of sale price`;
  if (cat.calcType === 'flat') return `${fmtMoneyPlain(cat.rate)} flat`;
  return 'Enter amount manually';
}

function computeCommission(cat, { baseValue, qty, manualAmount }) {
  if (!cat) return 0;
  if (cat.calcType === 'percentMRC' || cat.calcType === 'percentPrice') {
    const per = (Number(baseValue) || 0) * cat.rate;
    return cat.hasQty ? per * (Number(qty) || 1) : per;
  }
  if (cat.calcType === 'flat') return cat.noQty ? cat.rate : cat.rate * (Number(qty) || 1);
  return Number(manualAmount) || 0;
}

// Reference lineup of postpaid plans, compiled from t-mobile.com/cell-phone-plans.
// tiers: [lines, totalAccountPrice]. extraLine: [minLines, maxLines, pricePerLine] for lines beyond the last tier.
const PLANS = [
  {
    name: 'Experience Beyond 2.0', short: 'Standard', eligibility: 'Standard', family: 'Beyond', data: '250GB premium data',
    highlights: ['5-yr price guarantee', 'T-Satellite included', 'Netflix & Hulu on us', 'Apple TV $3/mo', 'Watch/tablet lines $5/mo', 'Up to 4K UHD streaming'],
    tiers: [[1, 105], [2, 180], [3, 230], [4, 280], [5, 330]], extraLine: [[6, 8, 50], [9, 12, 55]],
    // 3rd line free = you're billed the 2-line rate, and AutoPay counts 2 paid lines.
    thirdLineFree: { price: 180, autopayLines: 2 },
  },
  {
    name: 'Experience Beyond w/ First Responder Savings 2.0', short: 'First Responder', eligibility: 'First Responders', family: 'Beyond', data: '250GB premium data', verification: true,
    highlights: ['T-Priority on us', 'Same core Beyond benefits', 'Verified first responder pricing'],
    tiers: [[1, 90], [2, 140], [3, 180], [4, 220], [5, 260]], extraLine: [[6, 6, 40], [7, 12, 50]],
  },
  {
    name: 'Experience Beyond w/ Military Savings 2.0', short: 'Military & Veterans', eligibility: 'Military & Veterans', family: 'Beyond', data: '250GB premium data', verification: true,
    highlights: ['Same core Beyond benefits', 'Verified military pricing'],
    tiers: [[1, 90], [2, 140], [3, 180], [4, 220], [5, 260]], extraLine: [[6, 6, 40], [7, 12, 50]],
  },
  {
    name: 'Experience Beyond w/ 55+ Savings 2.0', short: '55+', eligibility: '55+', family: 'Beyond', data: '250GB premium data', verification: true,
    highlights: ['Same core Beyond benefits', 'Verified 55+ pricing'],
    tiers: [[1, 90], [2, 140]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Experience Beyond w/ Student Perks Savings 2.0', short: 'Student', eligibility: 'Students', family: 'Beyond', data: '120GB premium data', verification: true,
    highlights: ['Same core Beyond benefits', 'Qualifying student affiliation required'],
    tiers: [[1, 85], [2, 140]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Experience More 2.0', short: 'Standard', eligibility: 'Standard', family: 'More', data: '60GB premium data',
    highlights: ['5-yr price guarantee', 'Netflix on us', 'Apple TV $3/mo', '60GB hotspot included', 'Up to 4K UHD streaming'],
    tiers: [[1, 90], [2, 150], [3, 185], [4, 220], [5, 255]], extraLine: [[6, 8, 35], [9, 12, 40]],
    thirdLineFree: { price: 150, autopayLines: 2 },
  },
  {
    name: 'Experience More w/ First Responder Savings 2.0', short: 'First Responder', eligibility: 'First Responders', family: 'More', data: '60GB premium data', verification: true,
    highlights: ['T-Priority on us', 'Same core More benefits', 'Verified first responder pricing'],
    tiers: [[1, 75], [2, 110], [3, 135], [4, 160], [5, 185]], extraLine: [[6, 6, 25], [7, 12, 35]],
  },
  {
    name: 'Experience More w/ Military Savings 2.0', short: 'Military & Veterans', eligibility: 'Military & Veterans', family: 'More', data: '60GB premium data', verification: true,
    highlights: ['Same core More benefits', 'Verified military pricing'],
    tiers: [[1, 75], [2, 110], [3, 135], [4, 160], [5, 185]], extraLine: [[6, 6, 25], [7, 12, 35]],
  },
  {
    name: 'Experience More w/ 55+ Savings 2.0', short: '55+', eligibility: '55+', family: 'More', data: '60GB premium data', verification: true,
    highlights: ['Same core More benefits', 'Verified 55+ pricing'],
    tiers: [[1, 75], [2, 110]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Experience More w/ Student Perks Savings 2.0', short: 'Student', eligibility: 'Students', family: 'More', data: '60GB premium data', verification: true,
    highlights: ['Same core More benefits', 'Qualifying student affiliation required'],
    tiers: [[1, 70], [2, 120]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Essentials 2.0', short: 'Standard', eligibility: 'Standard', family: 'Essentials', data: '50GB premium data',
    highlights: ['Unlimited talk & text', 'Hotspot at max 3G speeds'],
    tiers: [[1, 65], [2, 100], [3, 120], [4, 140], [5, 160]], extraLine: [[6, 6, 20]], maxLines: 6,
    thirdLineFree: { price: 100, autopayLines: 2 },
  },
  {
    name: 'Essentials First Responder 2.0', short: 'First Responder', eligibility: 'First Responders', family: 'Essentials', data: '50GB premium data', verification: true,
    highlights: ['Unlimited talk & text', 'Verified first responder pricing'],
    tiers: [[1, 50], [2, 90], [3, 105], [4, 130], [5, 145]], extraLine: [[6, 6, 15]], maxLines: 6,
  },
  {
    name: 'Essentials Military 2.0', short: 'Military & Veterans', eligibility: 'Military & Veterans', family: 'Essentials', data: '50GB premium data', verification: true,
    highlights: ['Unlimited talk & text', 'Verified military pricing'],
    tiers: [[1, 50], [2, 90], [3, 105], [4, 130], [5, 145]], extraLine: [[6, 6, 15]], maxLines: 6,
  },
  {
    name: 'Essentials Choice 55 2.0', short: 'Choice 55', eligibility: '55+', family: 'Essentials', data: '50GB premium data', verification: true,
    highlights: ['Includes Scam Shield Premium', 'Verified 55+ pricing'],
    tiers: [[1, 50], [2, 70]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Essentials Saver 2.0', short: 'Standard', eligibility: 'Standard', family: 'Essentials Saver', data: '50GB premium data',
    highlights: ['Lowest-cost unlimited plan', 'Hotspot at max 3G speeds'],
    tiers: [[1, 55], [2, 90]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Essentials Saver w/ Student Perks Savings 2.0', short: 'Student', eligibility: 'Students', family: 'Essentials Saver', data: '50GB premium data', verification: true,
    highlights: ['Lowest-cost unlimited plan', 'Qualifying student affiliation required'],
    tiers: [[1, 35], [2, 70]], extraLine: [], maxLines: 2,
  },
  {
    name: 'Essentials 4 Line Offer 2.0', short: '4 Line Offer', eligibility: 'Standard', family: 'Essentials', data: '50GB premium data',
    highlights: ['Limited-time offer', 'Requires 4 lines (up to 6)'],
    tiers: [[4, 120], [5, 150]], extraLine: [[6, 6, 30]], minLines: 4, maxLines: 6,
  },
];

// 5G Home Internet plans (source: t-mobile.com/home-internet/plans). Unlike postpaid
// lines, these are a single flat monthly price per address — no per-line tiers.
const HOME_INTERNET_PLANS = [
  {
    name: 'Rely Home Internet', short: 'Rely',
    speed: 'Fast speeds', basePrice: 60,
    highlights: ['5-Year Price Guarantee', 'Wi-Fi 6 Gateway included', 'Unlimited data'],
  },
  {
    name: 'Amplified Home Internet', short: 'Amplified',
    speed: 'Fastest speeds, no speed caps', basePrice: 70,
    highlights: ['5-Year Price Guarantee', 'Wi-Fi 7 Gateway included', 'Unlimited data'],
  },
  {
    name: 'All-In Home Internet', short: 'All-In',
    speed: 'Fastest speeds + TechEdge Suite', basePrice: 80,
    highlights: ['Advanced Cyber Security', 'Hulu & Paramount+ on us', 'Wi-Fi 7 Gateway + mesh Wi-Fi'],
  },
];
// AutoPay takes $10/mo off any Home Internet plan; bundling with an active T-Mobile
// voice line takes a further $15/mo off (a billing credit, not a commission adjustment).
const HOME_INTERNET_AUTOPAY_DISCOUNT = 10;
const HOME_INTERNET_VOICE_LINE_DISCOUNT = 15;
function homeInternetPriceWithAutopay(plan, withVoiceLine) {
  let price = plan.basePrice - HOME_INTERNET_AUTOPAY_DISCOUNT;
  if (withVoiceLine) price -= HOME_INTERNET_VOICE_LINE_DISCOUNT;
  return Math.max(0, price);
}

// T-Mobile Fiber plans (source: t-mobile.com/home-internet/fiber). Same single
// flat monthly price per address as fixed-wireless Home Internet, but fiber only
// carries the AutoPay discount — no voice-line bundle credit.
const FIBER_PLANS = [
  {
    name: 'Fiber 300 Mbps', short: 'Fiber 300 Mbps',
    speed: 'Uploads just as fast as downloads', basePrice: 55,
    // Limited-time promo AutoPay price — below the standard $10 AutoPay discount.
    promoAutopayPrice: 35,
    highlights: ['100% fiber internet', 'Unlimited data', 'Wi-Fi router included', 'Installation included'],
  },
  {
    name: 'Fiber 1 Gig', short: 'Fiber 1 Gig',
    speed: 'Step up to more speed and performance', basePrice: 70,
    highlights: ['100% fiber internet', 'Unlimited data', 'Wi-Fi router + mesh extender as needed', 'Installation included'],
  },
  {
    name: 'Fiber 2 Gig', short: 'Fiber 2 Gig',
    speed: 'Fastest speeds, strongest Wi-Fi', basePrice: 80,
    highlights: ['100% fiber internet', 'Unlimited data', 'Wi-Fi router + mesh extender as needed', 'Installation included'],
  },
];
const FIBER_AUTOPAY_DISCOUNT = 10;
function fiberPriceWithAutopay(plan, ignorePromo) {
  if (!ignorePromo && plan.promoAutopayPrice != null) return plan.promoAutopayPrice;
  return Math.max(0, plan.basePrice - FIBER_AUTOPAY_DISCOUNT);
}

// T-Mobile Watch Line plans (source: t-mobile.com/cell-phone-plans/affordable-data-plans/
// smartwatches). basePrice is the list price (before AutoPay) — the site advertises the
// AutoPay price directly, so list = advertised + $5.
const WATCH_PLANS = [
  {
    name: 'Watch Plan 2.0', short: 'Watch Plan 2.0',
    speed: 'Unlimited talk, text, and high-speed data', basePrice: 15,
    highlights: ['Call, text, and browse from your watch', 'Unlimited talk, text, and high-speed data'],
  },
  {
    name: 'Watch Plan Plus 2.0', short: 'Watch Plan Plus 2.0',
    speed: 'Unlimited data plus international coverage', basePrice: 20,
    highlights: [
      'Call, text, and browse from your watch', 'Unlimited talk, text, and high-speed data',
      'Canada & Mexico: up to 15GB high-speed data', 'International: unlimited texting + up to 5GB data in 215+ countries',
    ],
  },
];
const WATCH_AUTOPAY_DISCOUNT = 5;
function watchPriceWithAutopay(plan) {
  return Math.max(0, plan.basePrice - WATCH_AUTOPAY_DISCOUNT);
}

// T-Mobile Tablet Line plans (source: t-mobile.com/cell-phone-plans/affordable-data-plans).
// Same pattern as Watch: advertised price is with AutoPay, list = advertised + $5.
const TABLET_PLANS = [
  {
    name: 'Tablet Essentials 2.0', short: 'Tablet Essentials 2.0',
    speed: '5GB high-speed data, then reduced speeds', basePrice: 20,
    highlights: ['5GB of high-speed data — no overages, ever', 'Unlimited 2G data in Canada & Mexico', 'Video streaming at up to 480p'],
  },
  {
    name: 'Tablet Unlimited 2.0', short: 'Tablet Unlimited 2.0',
    speed: 'Unlimited high-speed data', basePrice: 25,
    highlights: ['Unlimited high-speed data', 'HD video streaming', 'Canada & Mexico: unlimited texting + up to 5GB high-speed data', 'International: unlimited texting + up to 5GB in 11 countries'],
  },
  {
    name: 'Tablet Unlimited Plus 2.0', short: 'Tablet Unlimited Plus 2.0',
    speed: 'Unlimited data + 15GB hotspot', basePrice: 30,
    highlights: ['Unlimited high-speed data', '15GB high-speed mobile hotspot data', 'Full HD video streaming', 'International: unlimited texting + up to 5GB in 215+ countries'],
  },
];
const TABLET_AUTOPAY_DISCOUNT = 5;
function tabletPriceWithAutopay(plan) {
  return Math.max(0, plan.basePrice - TABLET_AUTOPAY_DISCOUNT);
}

// Display order for grouping plans in the picker. `key` matches plan.family;
// `title` is what the rep actually sees as the section heading.
const PLAN_FAMILIES = [
  { key: 'Beyond', title: 'Experience Beyond 2.0' },
  { key: 'More', title: 'Experience More 2.0' },
  { key: 'Essentials', title: 'Essentials 2.0' },
  { key: 'Essentials Saver', title: 'Essentials Saver 2.0' },
];

// Beyond and More are the premium tier; Essentials and Essentials Saver are not.
// Used so goals can auto-detect premium vs essential without any manual tagging —
// classification comes straight from each plan's family, set once above.
const PREMIUM_PLAN_FAMILIES = new Set(['Beyond', 'More']);
function planFamilyOf(planName) {
  const p = PLANS.find(pl => pl.name === planName);
  return p ? p.family : null;
}
function isPremiumPlanName(planName) {
  const fam = planFamilyOf(planName);
  return fam ? PREMIUM_PLAN_FAMILIES.has(fam) : false;
}

// Goals can target these instead of (or alongside) raw categories, since
// "Postpaid Rate Plan" alone doesn't distinguish Beyond/More from Essentials.
const VIRTUAL_GOAL_TAGS = {
  '__premiumPlans__': {
    label: 'Premium Rate Plans (Beyond / More)',
    match: it => it.category === 'Postpaid Rate Plan' && isPremiumPlanName(it.planName),
  },
  '__essentialPlans__': {
    label: 'Essential Rate Plans (Essentials / Saver)',
    match: it => it.category === 'Postpaid Rate Plan' && it.planName && !isPremiumPlanName(it.planName),
  },
};
function goalTagLabel(tag) {
  return VIRTUAL_GOAL_TAGS[tag] ? VIRTUAL_GOAL_TAGS[tag].label : tag;
}
function formatGoalNames(names) {
  return (names || []).map(goalTagLabel).join(', ');
}

// Some standard plans run a "3rd line free" promo. On T-Mobile's site the promo price equals
// the 2-line rate with AutoPay counted on 2 paid lines, so the promo is stored as a list price
// plus the number of lines AutoPay applies to, and the discount is derived from that.
function thirdLineFreePrice(plan) {
  return plan.thirdLineFree ? plan.thirdLineFree.price : null;
}

// Plans have a supported line range. The 4 Line Offer, for example, can't be quoted below 4 lines.
function planMinLines(plan) { return plan?.minLines || 1; }
function planMaxLines(plan) { return plan?.maxLines || 12; }
function planSupportsLines(plan, lines) {
  const n = Number(lines) || 1;
  return n >= planMinLines(plan) && n <= planMaxLines(plan);
}
function clampLines(plan, lines) {
  const n = Number(lines) || 1;
  return Math.min(Math.max(n, planMinLines(plan)), planMaxLines(plan));
}

function listPriceForLines(plan, lines) {
  const n = Number(lines) || 1;
  if (n === 3 && plan.thirdLineFree) return plan.thirdLineFree.price;
  return planPriceForLines(plan, lines);
}

function planPriceForLines(plan, lines) {
  if (!plan) return 0;
  const n = clampLines(plan, lines);
  const exact = plan.tiers.find(t => t[0] === n);
  if (exact) return exact[1];
  const first = plan.tiers[0];
  const last = plan.tiers[plan.tiers.length - 1];
  if (!last) return 0;
  if (n <= first[0]) return first[1];
  if (n <= last[0]) return last[1];
  let price = last[1];
  let cursor = last[0] + 1;
  for (const [min, max, perLine] of (plan.extraLine || [])) {
    if (cursor > n) break;
    const rangeEnd = Math.min(n, max);
    if (cursor <= rangeEnd) { price += (rangeEnd - cursor + 1) * perLine; cursor = rangeEnd + 1; }
  }
  return price;
}

// T-Mobile's AutoPay discount: $5/line/month with an eligible bank account or debit card, capped at 8 lines ($40 max)
const AUTOPAY_DISCOUNT_PER_LINE = 5;
const AUTOPAY_MAX_LINES = 8;

// With 3rd line free the customer is only billed for 2 lines, so AutoPay only counts those.
function autopayLinesFor(plan, lines, ignorePromo) {
  const n = Number(lines) || 1;
  if (!ignorePromo && n === 3 && plan?.thirdLineFree?.autopayLines) return plan.thirdLineFree.autopayLines;
  return n;
}
function autopayDiscount(lines) {
  return AUTOPAY_DISCOUNT_PER_LINE * Math.min(Number(lines) || 1, AUTOPAY_MAX_LINES);
}
function planPriceWithAutopay(plan, lines, ignorePromo) {
  const base = ignorePromo ? planPriceForLines(plan, lines) : listPriceForLines(plan, lines);
  return Math.max(0, base - autopayDiscount(autopayLinesFor(plan, lines, ignorePromo)));
}


// A customer's relationship tag is computed automatically from what's true about
// them — never set by hand — so there's nothing to keep in sync.
const RELATIONSHIP_STYLE = {
  'Customer': { bg: 'var(--positive-soft)', fg: 'var(--positive-ink)' },
  'Follow-up': { bg: 'var(--accent-soft)', fg: 'var(--accent-deep)' },
  'Contact': { bg: 'var(--neutral-soft)', fg: 'var(--ink-soft)' },
};
function relationshipTag(customer, hasSales) {
  if (hasSales) return 'Customer';
  if (customer?.nextFollowUp) return 'Follow-up';
  return 'Contact';
}

// Formats digits as (000) 000-0000 as the person types.
function formatPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '').slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const AVATAR_COLORS = ['#E20074', '#7C3AED', '#059669', '#D97706', '#2563EB', '#DB2777', '#0891B2'];

/* --------------------------------- helpers --------------------------------- */

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }

function todayInputValue() { return new Date().toISOString().slice(0, 10); }
function fmtDateNice(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

function useCountUp(value, duration = 550) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

/* ------------------------------- small pieces ------------------------------- */

// Signal bars — the app's signature mark. Bars fill to show how strong the
// current period is relative to the best period on record.
function SignalBars({ level = 4, total = 5, height = 22, gap = 3, barWidth = 5, color = 'var(--accent)', dim = 'rgba(255,255,255,0.18)', animate = true }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }}>
      {Array.from({ length: total }, (_, i) => {
        const h = ((i + 1) / total) * height;
        const on = i < level;
        return (
          <div
            key={i}
            className={animate ? 'bar' : undefined}
            style={{
              width: barWidth, height: h, borderRadius: barWidth / 2,
              background: on ? color : dim,
              animationDelay: animate ? `${i * 70}ms` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function Avatar({ name, size = 32 }) {
  return (
    <div
      className="font-display"
      style={{
        width: size, height: size, borderRadius: '50%', background: avatarColor(name),
        color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.4, fontWeight: 700, flexShrink: 0,
      }}
    >
      {initials(name)}
    </div>
  );
}

function Badge({ tag }) {
  const s = RELATIONSHIP_STYLE[tag] || RELATIONSHIP_STYLE['Contact'];
  return (
    <span style={{
      background: s.bg, color: s.fg, fontSize: 11.5, fontWeight: 700,
      padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>
      {tag}
    </span>
  );
}

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--ink-soft)' }}>
      <Icon size={30} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
      <div className="font-display" style={{ fontWeight: 700, color: 'var(--ink)', fontSize: 16 }}>{title}</div>
      {sub && <div style={{ fontSize: 13.5, marginTop: 4 }}>{sub}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

function Sheet({ open, onClose, title, children, elevated, swipeToClose, hideHandle, showClose = true }) {
  const [dragY, setDragY] = useState(0);
  const draggingRef = React.useRef(false);
  const startYRef = React.useRef(0);
  const scrollRef = React.useRef(null);

  if (!open) return null;

  function onSheetTouchStart(e) {
    if (!swipeToClose) return;
    // Only take over the gesture when the content is already scrolled to the
    // top — otherwise this would hijack normal scrolling through the list.
    if (scrollRef.current && scrollRef.current.scrollTop > 0) return;
    draggingRef.current = true;
    startYRef.current = e.touches[0].clientY;
  }
  function onSheetTouchMove(e) {
    if (!swipeToClose || !draggingRef.current) return;
    const delta = e.touches[0].clientY - startYRef.current;
    if (delta > 0) setDragY(delta);
  }
  function onSheetTouchEnd() {
    if (!swipeToClose || !draggingRef.current) return;
    draggingRef.current = false;
    if (dragY > 70) onClose();
    setDragY(0);
  }

  return (
    <div style={elevated ? { ...styles.sheetOverlay, zIndex: 26 } : styles.sheetOverlay} onClick={onClose}>
      <div
        style={{ ...styles.sheet, transform: `translateY(${dragY}px)`, transition: dragY ? 'none' : 'transform 200ms ease' }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onSheetTouchStart} onTouchMove={onSheetTouchMove} onTouchEnd={onSheetTouchEnd}
      >
        {!hideHandle && <div style={styles.sheetHandle} />}
        {(title || showClose) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div className="font-display" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.025em' }}>{title}</div>
            {showClose && <button onClick={onClose} style={styles.iconBtn} className="press"><X size={18} /></button>}
          </div>
        )}
        <div ref={scrollRef} style={{ maxHeight: '76vh', overflowY: 'auto', paddingBottom: 6, WebkitOverflowScrolling: 'touch' }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}


/* --------------------------------- modals --------------------------------- */

/* ------------------------------- sale form UI ------------------------------- */

// Maps a category to a recognizable icon so the picker reads at a glance.
function categoryIcon(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('watch')) return Watch;
  if (n.includes('tablet')) return Tablet;
  if (n.includes('internet') || n.includes('fiber')) return Wifi;
  if (n.includes('byod')) return Shield;
  if (n.includes('protection') || n.includes('360')) return ShieldCheck;
  if (n.includes('visa') || n.includes('card')) return CreditCard;
  if (n.includes('accessory')) return Package;
  if (n.includes('upgrade')) return ArrowUpCircle;
  if (n.includes('spiff') || n.includes('bonus')) return Gift;
  if (n.includes('prepaid')) return Zap;
  if (n.includes('voice') || n.includes('postpaid') || n.includes('plan')) return Smartphone;
  return DollarSign;
}

function SectionLabel({ children, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '18px 0 9px', gap: 10 }}>
      <div className="font-display" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--ink-faint)', textTransform: 'uppercase' }}>
        {children}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>{hint}</div>}
    </div>
  );
}

// Currency field with a fixed $ so the number itself stays the focus.
function MoneyInput({ value, onChange, placeholder = '0.00', autoFocus }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', borderRadius: 14, background: 'var(--surface)',
      border: `1.5px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
      boxShadow: focused ? '0 0 0 4px rgba(226,0,116,0.10)' : 'var(--shadow-sm)',
      transition: 'border-color 150ms ease, box-shadow 150ms ease', overflow: 'hidden',
    }}>
      <span className="font-display" style={{ padding: '0 4px 0 14px', fontSize: 19, fontWeight: 700, color: 'var(--ink-faint)' }}>$</span>
      <input
        type="number" inputMode="decimal" placeholder={placeholder} value={value} autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        className="font-display tabular"
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          padding: '13px 14px 13px 2px', fontSize: 21, fontWeight: 700, color: 'var(--ink)', minWidth: 0,
        }}
      />
    </div>
  );
}

function Stepper({ value, onChange, min = 1, max = 99 }) {
  const n = Number(value) || min;
  const btn = (disabled) => ({
    width: 44, height: 44, borderRadius: 13, border: '1px solid var(--border)',
    background: 'var(--surface)', color: disabled ? 'var(--ink-faint)' : 'var(--ink)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: disabled ? 'default' : 'pointer', flexShrink: 0, boxShadow: 'var(--shadow-sm)',
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button className="press" style={btn(n <= min)} disabled={n <= min} onClick={() => onChange(String(Math.max(min, n - 1)))}>
        <Minus size={17} strokeWidth={2.6} />
      </button>
      <div className="font-display tabular" style={{ flex: 1, textAlign: 'center', fontSize: 24, fontWeight: 800 }}>{n}</div>
      <button className="press" style={btn(n >= max)} disabled={n >= max} onClick={() => onChange(String(Math.min(max, n + 1)))}>
        <Plus size={17} strokeWidth={2.6} />
      </button>
    </div>
  );
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function MonthStepper({ value, onChange, label }) {
  const holdTimer = React.useRef(null);
  const holdInterval = React.useRef(null);

  function step(delta) { onChange(shiftMonth(value, delta)); }

  function startHold(delta) {
    step(delta);
    holdTimer.current = setTimeout(() => {
      holdInterval.current = setInterval(() => step(delta), 140);
    }, 450);
  }
  function endHold() {
    clearTimeout(holdTimer.current);
    clearInterval(holdInterval.current);
  }

  return (
    <div style={styles.monthStepper}>
      <button
        className="press" style={styles.monthStepperBtn}
        onMouseDown={() => startHold(-1)} onMouseUp={endHold} onMouseLeave={endHold}
        onTouchStart={() => startHold(-1)} onTouchEnd={endHold}
      >
        <ChevronLeft size={18} strokeWidth={2.4} />
      </button>
      <div className="font-display tabular" style={{ flex: 1, textAlign: 'center', fontSize: 14.5, fontWeight: 700 }}>
        {label}
      </div>
      <button
        className="press" style={styles.monthStepperBtn}
        onMouseDown={() => startHold(1)} onMouseUp={endHold} onMouseLeave={endHold}
        onTouchStart={() => startHold(1)} onTouchEnd={endHold}
      >
        <ChevronRight size={18} strokeWidth={2.4} />
      </button>
    </div>
  );
}

function SaleModal({ open, onClose, onSave, categories, initialPlan, spiffs, customers, onCreateCustomer }) {
  const emptyDraft = { category: '', baseValue: '', qty: '1', manualAmount: '', planName: '', lines: '1', alreadyProtected: false, isBYOD: false, isEssential: false, isPriority: false };
  const emptyForm = { date: todayInputValue(), notes: '', items: [], customerId: '' };
  const [form, setForm] = useState(emptyForm);
  const [draft, setDraft] = useState(emptyDraft);
  const [linkOpen, setLinkOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddName, setQuickAddName] = useState('');
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [hiPickerOpen, setHiPickerOpen] = useState(false);
  const [fiberPickerOpen, setFiberPickerOpen] = useState(false);
  const [watchPickerOpen, setWatchPickerOpen] = useState(false);
  const [tabletPickerOpen, setTabletPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm);
    setLinkOpen(false);
    setQuickAddOpen(false);
    setQuickAddName('');
    setPlanPickerOpen(false);
    setHiPickerOpen(false);
    setFiberPickerOpen(false);
    setWatchPickerOpen(false);
    setTabletPickerOpen(false);
    if (initialPlan?.plan) {
      const price = listPriceForLines(initialPlan.plan, initialPlan.lines);
      setDraft({
        ...emptyDraft, category: 'Postpaid Rate Plan',
        planName: initialPlan.plan.name, lines: String(initialPlan.lines), baseValue: String(price),
      });
    } else if (initialPlan?.homeInternetPlan) {
      setDraft({
        ...emptyDraft, category: 'Home Internet',
        planName: initialPlan.homeInternetPlan.name, baseValue: String(initialPlan.homeInternetPlan.basePrice),
      });
    } else if (initialPlan?.fiberPlan) {
      setDraft({
        ...emptyDraft, category: 'Fiber Activation',
        planName: initialPlan.fiberPlan.name, baseValue: String(initialPlan.fiberPlan.basePrice),
      });
    } else if (initialPlan?.watchPlan) {
      setDraft({
        ...emptyDraft, category: 'Watch Line',
        planName: initialPlan.watchPlan.name, baseValue: String(initialPlan.watchPlan.basePrice),
      });
    } else if (initialPlan?.tabletPlan) {
      setDraft({
        ...emptyDraft, category: 'Tablet Line',
        planName: initialPlan.tabletPlan.name, baseValue: String(initialPlan.tabletPlan.basePrice),
      });
    } else {
      setDraft(emptyDraft);
    }
  }, [open, initialPlan]); // eslint-disable-line

  const pickable = categories.filter(c => !HIDDEN_IN_PICKER.includes(c.name));
  const draftCat = categories.find(c => c.name === draft.category);
  const isPlanCategory = draft.category === 'Postpaid Rate Plan';
  const isHomeInternetCategory = draft.category === 'Home Internet';
  const isFiberCategory = draft.category === 'Fiber Activation';
  const isWatchCategory = draft.category === 'Watch Line';
  const isTabletCategory = draft.category === 'Tablet Line';
  const selectedPlan = PLANS.find(p => p.name === draft.planName) || null;
  const selectedHomeInternet = HOME_INTERNET_PLANS.find(p => p.name === draft.planName) || null;
  const selectedFiber = FIBER_PLANS.find(p => p.name === draft.planName) || null;
  const selectedWatch = WATCH_PLANS.find(p => p.name === draft.planName) || null;
  const selectedTablet = TABLET_PLANS.find(p => p.name === draft.planName) || null;
  const draftAmount = computeCommission(draftCat, draft);
  const activeDraftSpiffs = activeSpiffsFor(spiffs, draft.category, draft.planName);
  const draftSpiffPerUnit = spiffTotalFor(spiffs, draft.category, draft.planName);
  const draftSpiffTotal = draftSpiffPerUnit * effectiveUnits(draftCat, draft);
  const draftGrandTotal = draftAmount + draftSpiffTotal;
  const total = form.items.reduce((s, it) => s + Number(it.amount || 0), 0);

  function pickPlan(name, lines) {
    const plan = PLANS.find(p => p.name === name);
    // Plans have a supported line range (the 4 Line Offer starts at 4), so snap into it.
    const n = plan ? clampLines(plan, lines) : lines;
    const price = plan ? listPriceForLines(plan, n) : '';
    setDraft({ ...draft, planName: name, lines: String(n), baseValue: plan ? String(price) : draft.baseValue });
  }

  function pickHomeInternet(name) {
    const plan = HOME_INTERNET_PLANS.find(p => p.name === name);
    // Commission is on the full plan price, same as postpaid — AutoPay and the
    // voice-line bundle credit are customer-facing discounts only.
    setDraft({ ...draft, planName: name, baseValue: plan ? String(plan.basePrice) : draft.baseValue });
  }

  function pickFiber(name) {
    const plan = FIBER_PLANS.find(p => p.name === name);
    setDraft({ ...draft, planName: name, baseValue: plan ? String(plan.basePrice) : draft.baseValue });
  }

  function pickWatch(name) {
    const plan = WATCH_PLANS.find(p => p.name === name);
    setDraft({ ...draft, planName: name, baseValue: plan ? String(plan.basePrice) : draft.baseValue });
  }

  function pickTablet(name) {
    const plan = TABLET_PLANS.find(p => p.name === name);
    setDraft({ ...draft, planName: name, baseValue: plan ? String(plan.basePrice) : draft.baseValue });
  }

  function addItem() {
    if (!draftCat || draftGrandTotal <= 0) return;
    const item = {
      id: uid(),
      category: draft.category,
      amount: Math.round(draftGrandTotal * 100) / 100,
      baseAmount: Math.round(draftAmount * 100) / 100,
    };
    if (draftCat.calcType === 'percentMRC' || draftCat.calcType === 'percentPrice') item.baseValue = Number(draft.baseValue) || 0;
    if (!draftCat.noQty && (draftCat.calcType === 'flat' || draftCat.hasQty)) item.qty = Number(draft.qty) || 1;
    if ((isPlanCategory || isHomeInternetCategory || isFiberCategory || isWatchCategory || isTabletCategory) && draft.planName) item.planName = draft.planName;
    if (draft.category === 'Upgrade' && draft.alreadyProtected) item.alreadyProtected = true;
    if (draft.category === 'Voice Line' && draft.isBYOD) item.isBYOD = true;
    if (draft.category === 'Accessories' && draft.isEssential) item.isEssential = true;
    if (draft.category === 'Visa' && draft.isPriority) item.isPriority = true;
    if (draftSpiffTotal > 0) {
      item.spiffAmount = Math.round(draftSpiffTotal * 100) / 100;
      item.spiffLabels = activeDraftSpiffs.map(s => s.label);
    }
    setForm(f => ({ ...f, items: [...f.items, item] }));
    setDraft(emptyDraft);
  }

  function removeItem(id) {
    setForm(f => ({ ...f, items: f.items.filter(i => i.id !== id) }));
  }

  // Bump an already-added item's quantity and re-run its commission math.
  function changeQty(id, delta) {
    setForm(f => ({
      ...f,
      items: f.items.map(it => {
        if (it.id !== id) return it;
        const cat = categories.find(c => c.name === it.category);
        if (!cat) return it;
        const nextQty = Math.min(99, Math.max(1, (Number(it.qty) || 1) + delta));
        const base = computeCommission(cat, {
          baseValue: it.baseValue,
          qty: nextQty,
          manualAmount: it.baseAmount ?? it.amount,
        });
        const spiffPerUnit = spiffTotalFor(spiffs, it.category, it.planName);
        const units = effectiveUnits(cat, { qty: nextQty });
        const spiffAmount = spiffPerUnit * units;
        const next = { ...it, qty: nextQty, baseAmount: Math.round(base * 100) / 100 };
        if (spiffAmount > 0) {
          next.spiffAmount = Math.round(spiffAmount * 100) / 100;
          next.spiffLabels = activeSpiffsFor(spiffs, it.category, it.planName).map(s => s.label);
        } else {
          delete next.spiffAmount;
          delete next.spiffLabels;
        }
        next.amount = Math.round((base + spiffAmount) * 100) / 100;
        return next;
      }),
    }));
  }

  async function submitQuickAdd() {
    if (!quickAddName.trim() || !onCreateCustomer) return;
    const newCustomer = await onCreateCustomer(quickAddName);
    if (newCustomer) {
      setForm(f => ({ ...f, customerId: newCustomer.id }));
      setQuickAddOpen(false);
      setQuickAddName('');
      setLinkOpen(false);
    }
  }

  function submit() {
    if (form.items.length === 0) return;
    onSave({
      date: form.date,
      notes: form.notes,
      items: form.items,
      customerId: form.customerId,
      amount: Math.round(total * 100) / 100,
      category: form.items.length === 1 ? form.items[0].category : `${form.items.length} items`,
    });
  }

  const todayStr = todayInputValue();
  const yest = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const needsBase = draftCat && (draftCat.calcType === 'percentMRC' || draftCat.calcType === 'percentPrice');
  const ready = form.items.length > 0;

  return (
    <Sheet open={open} onClose={onClose} title="" swipeToClose hideHandle showClose={false}>
      {/* running transaction total */}
      <div style={{ ...styles.ticker, opacity: ready ? 1 : 0.55 }}>
        <div style={styles.tickerGlow} />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.09em', opacity: 0.66 }}>TRANSACTION TOTAL</div>
            <div className="font-display tabular" style={{ fontSize: 30, fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1.1 }}>
              {fmtMoney(total)}
            </div>
          </div>
          {form.items.length > 0 && (
            <div style={{ textAlign: 'right', fontSize: 11, opacity: 0.6 }}>
              {form.items.length} item{form.items.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>

      <SectionLabel>When</SectionLabel>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        <button className="press" style={form.date === todayStr ? styles.chipOn : styles.chip} onClick={() => setForm({ ...form, date: todayStr })}>Today</button>
        <button className="press" style={form.date === yest ? styles.chipOn : styles.chip} onClick={() => setForm({ ...form, date: yest })}>Yesterday</button>
        <input
          type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
          style={{ ...styles.input, flex: 1, padding: '9px 11px', fontSize: 13 }}
        />
      </div>

      {/* customer link — compact, optional, collapsed unless in use */}
      {(() => {
        const linkedCustomer = customers?.find(x => x.id === form.customerId);
        if (linkedCustomer) {
          return (
            <div style={{ ...styles.linkedCustomerRow, marginTop: 14 }}>
              <Avatar name={linkedCustomer.name} size={30} />
              <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {linkedCustomer.name}
              </div>
              <button style={styles.iconBtnSm} onClick={() => setForm({ ...form, customerId: '' })}><X size={13} /></button>
            </div>
          );
        }
        if (!linkOpen) {
          return (
            <button className="press" style={{ ...styles.linkCustomerBtn, marginTop: 14 }} onClick={() => setLinkOpen(true)}>
              <UserPlus size={14} style={{ marginRight: 7 }} /> Link a customer
            </button>
          );
        }
        return (
          <div style={{ marginTop: 14 }}>
            {quickAddOpen ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={quickAddName} onChange={e => setQuickAddName(e.target.value)} placeholder="Customer name"
                  style={{ ...styles.input, flex: 1 }} onKeyDown={e => e.key === 'Enter' && submitQuickAdd()} autoFocus
                />
                <button className="press" style={styles.secondaryBtn} onClick={submitQuickAdd}><Check size={16} strokeWidth={2.6} /></button>
                <button className="press" style={styles.secondaryBtn} onClick={() => { setQuickAddOpen(false); setQuickAddName(''); }}><X size={16} /></button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value="" onChange={e => e.target.value === '__new__' ? setQuickAddOpen(true) : setForm({ ...form, customerId: e.target.value })}
                  style={{ ...styles.input, flex: 1 }} autoFocus
                >
                  <option value="">Pick a customer…</option>
                  {customers?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  <option value="__new__">+ Add new customer…</option>
                </select>
                <button style={styles.iconBtnSm} onClick={() => setLinkOpen(false)}><X size={14} /></button>
              </div>
            )}
          </div>
        );
      })()}

      {/* what's already in this transaction */}
      {form.items.length > 0 && (
        <>
          <SectionLabel hint={fmtMoney(total)}>In this transaction</SectionLabel>
          {form.items.map((it, i) => {
            const Icon = categoryIcon(it.category);
            const cat = categories.find(c => c.name === it.category);
            const qtyAdjustable = !!cat && !cat.noQty && (cat.calcType === 'flat' || cat.hasQty);
            const qty = Number(it.qty) || 1;
            const detail = it.planName
              ? it.planName
              : it.baseValue != null
                ? `${fmtMoneyPlain(it.baseValue)} each`
                : cat?.calcType === 'flat'
                  ? `${fmtMoneyPlain(cat.rate)} each`
                  : '';
            return (
              <div key={it.id} className="rise" style={{ ...styles.lineItem, animationDelay: `${i * 40}ms` }}>
                <div style={styles.lineItemIcon}><Icon size={15} strokeWidth={2.1} color="var(--accent)" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>{it.category}</span>
                    {qty > 1 && <span style={styles.qtyBadge}>Qty {qty}</span>}
                    {it.spiffAmount > 0 && (
                      <span style={styles.spiffBadge}><Zap size={9} strokeWidth={3} />+{fmtMoneyPlain(it.spiffAmount)} SPIFF</span>
                    )}
                  </div>
                  {detail && <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 1 }}>{detail}</div>}
                  {qtyAdjustable && (
                    <div style={styles.qtyRow}>
                      <button
                        className="press" style={styles.qtyBtn}
                        disabled={qty <= 1} onClick={() => changeQty(it.id, -1)}
                      >
                        <Minus size={13} strokeWidth={2.8} />
                      </button>
                      <span className="font-display tabular" style={{ fontSize: 13.5, fontWeight: 800, minWidth: 16, textAlign: 'center' }}>{qty}</span>
                      <button className="press" style={styles.qtyBtn} onClick={() => changeQty(it.id, 1)}>
                        <Plus size={13} strokeWidth={2.8} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--positive)' }}>{fmtMoney(it.amount)}</div>
                <button style={styles.iconBtnSm} onClick={() => removeItem(it.id)}><X size={13} /></button>
              </div>
            );
          })}
        </>
      )}

      {/* add another item */}
      <SectionLabel hint={draftAmount > 0 ? fmtMoney(draftAmount) : undefined}>
        {form.items.length > 0 ? 'Add another item' : 'What you sold'}
      </SectionLabel>
      <div style={styles.catGrid}>
        {pickable.map(c2 => {
          const Icon = categoryIcon(c2.name);
          const on = draft.category === c2.name;
          return (
            <button
              key={c2.name} className="press"
              style={on ? styles.catTileOn : styles.catTile}
              onClick={() => setDraft({ ...emptyDraft, category: on ? '' : c2.name })}
            >
              <Icon size={17} strokeWidth={2.1} color={on ? '#fff' : 'var(--accent)'} />
              <span style={{ fontSize: 11.5, fontWeight: on ? 700 : 600, lineHeight: 1.25, textAlign: 'center' }}>{c2.name}</span>
            </button>
          );
        })}
      </div>

      {draftCat && (
        <div className="rise" style={styles.draftPanel}>
          {isPlanCategory && (
            <>
              <button
                className="press lift" style={styles.planTrigger}
                onClick={() => setPlanPickerOpen(true)}
              >
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  {selectedPlan ? (
                    <>
                      <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3 }}>{selectedPlan.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>
                        {selectedPlan.eligibility} · {selectedPlan.data}
                      </div>
                    </>
                  ) : (
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-faint)' }}>Choose a plan</span>
                  )}
                </div>
                <ChevronDown size={17} strokeWidth={2.4} color="var(--ink-faint)" style={{ flexShrink: 0 }} />
              </button>

              {draft.planName && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', margin: '12px 0 8px' }}>Lines on the account</div>
                  <Stepper
                    value={draft.lines}
                    min={planMinLines(selectedPlan)}
                    max={planMaxLines(selectedPlan)}
                    onChange={v => pickPlan(draft.planName, v)}
                  />
                </>
              )}
            </>
          )}

          {isHomeInternetCategory && (
            <button
              className="press lift" style={styles.planTrigger}
              onClick={() => setHiPickerOpen(true)}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                {selectedHomeInternet ? (
                  <>
                    <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, color: 'var(--accent)' }}>{selectedHomeInternet.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{selectedHomeInternet.speed}</div>
                  </>
                ) : (
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-faint)' }}>Choose a plan</span>
                )}
              </div>
              <ChevronDown size={17} strokeWidth={2.4} color="var(--ink-faint)" style={{ flexShrink: 0 }} />
            </button>
          )}

          {isFiberCategory && (
            <button
              className="press lift" style={styles.planTrigger}
              onClick={() => setFiberPickerOpen(true)}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                {selectedFiber ? (
                  <>
                    <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, color: 'var(--accent)' }}>{selectedFiber.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{selectedFiber.speed}</div>
                  </>
                ) : (
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-faint)' }}>Choose a plan</span>
                )}
              </div>
              <ChevronDown size={17} strokeWidth={2.4} color="var(--ink-faint)" style={{ flexShrink: 0 }} />
            </button>
          )}

          {isWatchCategory && (
            <button
              className="press lift" style={styles.planTrigger}
              onClick={() => setWatchPickerOpen(true)}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                {selectedWatch ? (
                  <>
                    <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, color: 'var(--accent)' }}>{selectedWatch.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{selectedWatch.speed}</div>
                  </>
                ) : (
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-faint)' }}>Choose a plan</span>
                )}
              </div>
              <ChevronDown size={17} strokeWidth={2.4} color="var(--ink-faint)" style={{ flexShrink: 0 }} />
            </button>
          )}

          {isTabletCategory && (
            <button
              className="press lift" style={styles.planTrigger}
              onClick={() => setTabletPickerOpen(true)}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                {selectedTablet ? (
                  <>
                    <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, color: 'var(--accent)' }}>{selectedTablet.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{selectedTablet.speed}</div>
                  </>
                ) : (
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-faint)' }}>Choose a plan</span>
                )}
              </div>
              <ChevronDown size={17} strokeWidth={2.4} color="var(--ink-faint)" style={{ flexShrink: 0 }} />
            </button>
          )}

          {needsBase && !isHomeInternetCategory && !isFiberCategory && !isWatchCategory && !isTabletCategory && (
            <div style={{ marginTop: isPlanCategory ? 12 : 0 }}>
              <MoneyInput value={draft.baseValue} onChange={v => setDraft({ ...draft, baseValue: v })} />
            </div>
          )}

          {needsBase && draftCat.hasQty && (
            <div style={{ marginTop: 12 }}>
              <Stepper value={draft.qty} onChange={v => setDraft({ ...draft, qty: v })} />
            </div>
          )}

          {draftCat.calcType === 'flat' && !draftCat.noQty && (
            <Stepper value={draft.qty} onChange={v => setDraft({ ...draft, qty: v })} />
          )}

          {draftCat.calcType === 'manual' && (
            <MoneyInput value={draft.manualAmount} onChange={v => setDraft({ ...draft, manualAmount: v })} />
          )}

          {activeDraftSpiffs.length > 0 && draftSpiffTotal > 0 && (
            <div style={{ ...styles.spiffCallout, justifyContent: 'center', textAlign: 'center' }}>
              <Zap size={13} style={{ flexShrink: 0 }} />
              <span>
                {activeDraftSpiffs.map(s => s.label).join(', ')} · +{fmtMoney(draftSpiffTotal)} SPIFF
              </span>
            </div>
          )}

          <button
            className="press"
            style={{
              ...styles.addItemBtn,
              opacity: draftGrandTotal > 0 ? 1 : 0.4,
              cursor: draftGrandTotal > 0 ? 'pointer' : 'default',
            }}
            disabled={draftGrandTotal <= 0} onClick={addItem}
          >
            <Plus size={16} strokeWidth={2.6} style={{ marginRight: 6 }} />
            {draftGrandTotal > 0 ? `Add to transaction \u00b7 ${fmtMoney(draftGrandTotal)}` : 'Enter an amount'}
          </button>

          {draft.category === 'Upgrade' && (
            <label style={{ ...styles.checkboxRowWarn, justifyContent: 'center', textAlign: 'center' }}>
              <input
                type="checkbox" checked={draft.alreadyProtected}
                onChange={e => setDraft({ ...draft, alreadyProtected: e.target.checked })}
              />
              Line already has protection
            </label>
          )}

          {draft.category === 'Accessories' && (
            <label style={{ ...styles.checkboxRowWarn, justifyContent: 'center', textAlign: 'center' }}>
              <input
                type="checkbox" checked={draft.isEssential}
                onChange={e => setDraft({ ...draft, isEssential: e.target.checked })}
              />
              Essential Accessories
            </label>
          )}

          {draft.category === 'Visa' && (
            <label style={{ ...styles.checkboxRowWarn, justifyContent: 'center', textAlign: 'center' }}>
              <input
                type="checkbox" checked={draft.isPriority}
                onChange={e => setDraft({ ...draft, isPriority: e.target.checked })}
              />
              Priority Customer
            </label>
          )}

          {draft.category === 'Voice Line' && (
            <label style={{ ...styles.checkboxRowWarn, justifyContent: 'center', textAlign: 'center' }}>
              <input
                type="checkbox" checked={draft.isBYOD}
                onChange={e => setDraft({ ...draft, isBYOD: e.target.checked })}
              />
              Bring your own device (BYOD)
            </label>
          )}
        </div>
      )}

      <SectionLabel>Notes</SectionLabel>
      <textarea
        rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
        placeholder="Anything worth remembering about this transaction"
        style={{ ...styles.input, resize: 'vertical' }}
      />

      <button
        className="press"
        style={{ ...styles.primaryBtn, marginTop: 18, opacity: ready ? 1 : 0.4, cursor: ready ? 'pointer' : 'default', boxShadow: ready ? 'var(--shadow-glow)' : 'none' }}
        disabled={!ready} onClick={submit}
      >
        {ready ? `Save transaction \u00b7 ${fmtMoney(total)}` : 'Add at least one item'}
      </button>

      {/* plan picker — replaces the OS dropdown so it matches the rest of the app */}
      <Sheet elevated open={planPickerOpen} onClose={() => setPlanPickerOpen(false)} title="Choose a plan">
        <div style={styles.planPickerNote}>
          Prices shown at {clampLines(selectedPlan || PLANS[0], draft.lines)} line
          {clampLines(selectedPlan || PLANS[0], draft.lines) > 1 ? 's' : ''} with AutoPay
        </div>
        {PLAN_FAMILIES.map(({ key, title }) => {
          const inFamily = PLANS.filter(p => p.family === key);
          if (!inFamily.length) return null;
          return (
            <div key={key} style={{ marginBottom: 16 }}>
              <div style={styles.planGroupLabel}><span style={styles.planGroupDot} />{title}</div>
              {inFamily.map(p => {
                const on = p.name === draft.planName;
                const lines = clampLines(p, draft.lines);
                return (
                  <button
                    key={p.name} className="press"
                    style={on ? styles.planOptionOn : styles.planOption}
                    onClick={() => { pickPlan(p.name, draft.lines); setPlanPickerOpen(false); }}
                  >
                    <span style={styles.planOptionName}>{p.short || p.name}</span>
                    <span className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--positive)', flexShrink: 0 }}>
                      {fmtMoneyPlain(planPriceWithAutopay(p, lines))}
                    </span>
                    {on && (
                      <div style={styles.planCheck}><Check size={13} strokeWidth={3} color="#fff" /></div>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </Sheet>

      {/* home internet picker */}
      <Sheet elevated open={hiPickerOpen} onClose={() => setHiPickerOpen(false)} title="Choose a home internet plan">
        {HOME_INTERNET_PLANS.map(p => {
          const on = p.name === draft.planName;
          return (
            <button
              key={p.name} className="press"
              style={{ ...(on ? styles.planOptionOn : styles.planOption), alignItems: 'flex-start', height: 'auto', paddingTop: 12, paddingBottom: 12 }}
              onClick={() => { pickHomeInternet(p.name); setHiPickerOpen(false); }}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }}>{p.short}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{p.speed}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', marginTop: 5 }}>
                  {fmtMoneyPlain(homeInternetPriceWithAutopay(p, true))} bundled w/ voice line
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--positive)' }}>
                  {fmtMoneyPlain(homeInternetPriceWithAutopay(p, false))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 }}>w/ AutoPay</div>
              </div>
              {on && (
                <div style={{ ...styles.planCheck, marginTop: 2 }}><Check size={13} strokeWidth={3} color="#fff" /></div>
              )}
            </button>
          );
        })}
      </Sheet>

      {/* fiber picker */}
      <Sheet elevated open={fiberPickerOpen} onClose={() => setFiberPickerOpen(false)} title="Choose a fiber plan">
        {FIBER_PLANS.map(p => {
          const on = p.name === draft.planName;
          return (
            <button
              key={p.name} className="press"
              style={{ ...(on ? styles.planOptionOn : styles.planOption), alignItems: 'flex-start', height: 'auto', paddingTop: 12, paddingBottom: 12 }}
              onClick={() => { pickFiber(p.name); setFiberPickerOpen(false); }}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }}>{p.short}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{p.speed}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--positive)' }}>
                  {fmtMoneyPlain(fiberPriceWithAutopay(p))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 }}>w/ AutoPay</div>
              </div>
              {on && (
                <div style={{ ...styles.planCheck, marginTop: 2 }}><Check size={13} strokeWidth={3} color="#fff" /></div>
              )}
            </button>
          );
        })}
      </Sheet>

      {/* watch picker */}
      <Sheet elevated open={watchPickerOpen} onClose={() => setWatchPickerOpen(false)} title="Choose a watch plan">
        {WATCH_PLANS.map(p => {
          const on = p.name === draft.planName;
          return (
            <button
              key={p.name} className="press"
              style={{ ...(on ? styles.planOptionOn : styles.planOption), alignItems: 'flex-start', height: 'auto', paddingTop: 12, paddingBottom: 12 }}
              onClick={() => { pickWatch(p.name); setWatchPickerOpen(false); }}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }}>{p.short}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{p.speed}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--positive)' }}>
                  {fmtMoneyPlain(watchPriceWithAutopay(p))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 }}>w/ AutoPay</div>
              </div>
              {on && (
                <div style={{ ...styles.planCheck, marginTop: 2 }}><Check size={13} strokeWidth={3} color="#fff" /></div>
              )}
            </button>
          );
        })}
      </Sheet>

      {/* tablet picker */}
      <Sheet elevated open={tabletPickerOpen} onClose={() => setTabletPickerOpen(false)} title="Choose a tablet plan">
        {TABLET_PLANS.map(p => {
          const on = p.name === draft.planName;
          return (
            <button
              key={p.name} className="press"
              style={{ ...(on ? styles.planOptionOn : styles.planOption), alignItems: 'flex-start', height: 'auto', paddingTop: 12, paddingBottom: 12 }}
              onClick={() => { pickTablet(p.name); setTabletPickerOpen(false); }}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }}>{p.short}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{p.speed}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--positive)' }}>
                  {fmtMoneyPlain(tabletPriceWithAutopay(p))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 1 }}>w/ AutoPay</div>
              </div>
              {on && (
                <div style={{ ...styles.planCheck, marginTop: 2 }}><Check size={13} strokeWidth={3} color="#fff" /></div>
              )}
            </button>
          );
        })}
      </Sheet>
    </Sheet>
  );
}

function CustomerModal({ open, onClose, onSave, onDelete, initial, commissions }) {
  const empty = { name: '', phone: '', email: '', notes: '', nextFollowUp: '' };
  const [form, setForm] = useState(empty);
  const [noEmail, setNoEmail] = useState(false);
  const [noPhone, setNoPhone] = useState(false);
  useEffect(() => {
    if (!open) return;
    const next = initial || empty;
    setForm(next);
    setNoEmail(!!initial && !initial.email);
    setNoPhone(!!initial && !initial.phone);
  }, [open, initial]); // eslint-disable-line

  function submit() {
    if (!form.name.trim()) return;
    onSave({ ...form, email: noEmail ? '' : form.email, phone: noPhone ? '' : form.phone });
  }

  const history = initial
    ? (commissions || []).filter(c => c.customerId === initial.id).sort((a, b) => new Date(b.date) - new Date(a.date))
    : [];
  const historyTotal = history.reduce((s, c) => s + Number(c.amount || 0), 0);
  const tag = relationshipTag(initial, history.length > 0);

  return (
    <Sheet open={open} onClose={onClose} title={initial ? 'Edit customer' : 'Add customer'}>
      {initial && (
        <div style={{ marginBottom: 16 }}>
          <Badge tag={tag} />
        </div>
      )}

      <Field label="Name">
        <input
          value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
          style={styles.input} placeholder="Full name" autoFocus={!initial}
        />
      </Field>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)' }}>Phone</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--ink-faint)' }}>
          <input
            type="checkbox" checked={noPhone}
            onChange={e => { setNoPhone(e.target.checked); if (e.target.checked) setForm({ ...form, phone: '' }); }}
            style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
          />
          No phone
        </label>
      </div>
      <div style={{ marginBottom: 14 }}>
        <input
          value={form.phone} inputMode="tel" disabled={noPhone}
          onChange={e => setForm({ ...form, phone: formatPhone(e.target.value) })}
          style={{ ...styles.input, opacity: noPhone ? 0.45 : 1 }}
          placeholder={noPhone ? 'No phone on file' : '(000) 000-0000'}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)' }}>Email</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--ink-faint)' }}>
          <input
            type="checkbox" checked={noEmail}
            onChange={e => { setNoEmail(e.target.checked); if (e.target.checked) setForm({ ...form, email: '' }); }}
            style={{ width: 14, height: 14, accentColor: 'var(--accent)' }}
          />
          No email
        </label>
      </div>
      <div style={{ marginBottom: 14 }}>
        <input
          value={form.email} disabled={noEmail}
          onChange={e => setForm({ ...form, email: e.target.value })}
          style={{ ...styles.input, opacity: noEmail ? 0.45 : 1 }}
          placeholder={noEmail ? 'No email on file' : 'name@email.com'}
        />
      </div>

      <Field label="Next follow-up (optional)">
        <input type="date" value={form.nextFollowUp} onChange={e => setForm({ ...form, nextFollowUp: e.target.value })} style={styles.input} />
      </Field>
      <Field label="Notes">
        <textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...styles.input, resize: 'vertical' }} placeholder="Plan, device, preferences, conversation history..." />
      </Field>
      <button style={styles.primaryBtn} onClick={submit}>{initial ? 'Save changes' : 'Add customer'}</button>
      {initial && onDelete && (
        <button style={styles.deleteLink} onClick={onDelete}>Delete customer</button>
      )}

      {initial && (
        <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-soft)' }}>TRANSACTIONS</div>
            {history.length > 0 && (
              <div className="font-display tabular" style={{ fontSize: 13, fontWeight: 800, color: 'var(--positive)' }}>{fmtMoney(historyTotal)}</div>
            )}
          </div>
          {history.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>No transactions linked yet. Link one next time you log a sale.</div>
          ) : (
            history.map(h => {
              const items = Array.isArray(h.items) && h.items.length ? h.items : null;
              return (
                <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                        {items && items.length > 1 ? `${items.length} items` : (items ? items[0].category : h.category)}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>{fmtDateNice(h.date)}</div>
                    </div>
                    <div className="font-display tabular" style={{ fontSize: 13.5, fontWeight: 800, flexShrink: 0 }}>{fmtMoney(h.amount)}</div>
                  </div>
                  {items && items.length > 1 && (
                    <div style={{ marginTop: 5, paddingLeft: 2 }}>
                      {items.map((it, i) => (
                        <div key={it.id || i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: 'var(--ink-soft)', padding: '2px 0' }}>
                          <span>{it.category}</span>
                          <span className="tabular">{fmtMoney(it.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </Sheet>
  );
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState('');
  const [themePref, setThemePref] = useState('system'); // light | dark | system
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );
  const hydratedRef = React.useRef(false);
  const pushTimerRef = React.useRef(null);
  const [nameInput, setNameInput] = useState('');
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [spiffs, setSpiffs] = useState([]);
  const [goals, setGoals] = useState({});
  const [commissions, setCommissions] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [tab, setTab] = useState('dashboard');
  const [statPeriod, setStatPeriod] = useState('month');
  const [saleMonth, setSaleMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [goalMonth, setGoalMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [reconcileText, setReconcileText] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [showSaleModal, setShowSaleModal] = useState(false);
  const [saleModalPlan, setSaleModalPlan] = useState(null);
  const [planFilter, setPlanFilter] = useState('Standard');
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [planSubTab, setPlanSubTab] = useState('phone'); // 'phone' | 'internet'
  const [customerModal, setCustomerModal] = useState({ open: false, initial: null, id: null });
  const [newCat, setNewCat] = useState({ name: '', calcType: 'manual', rate: '' });
  const [newSpiff, setNewSpiff] = useState({ label: '', categoryName: '', planName: '', amount: '' });
  const [adminGoalMonth, setAdminGoalMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [adminGoalType, setAdminGoalType] = useState('fullTime');
  const [newGoal, setNewGoal] = useState({ name: '', target: '', goalType: 'units', categoryNames: [], baseCategoryNames: [] });
  const [editingGoalId, setEditingGoalId] = useState(null);
  const backupFileRef = React.useRef(null);
  const [backupError, setBackupError] = useState('');
  const [teamConfigStatus, setTeamConfigStatus] = useState('idle'); // idle | syncing | synced | error
  const [teamConfigError, setTeamConfigError] = useState('');
  const [teamConfigUpdatedAt, setTeamConfigUpdatedAt] = useState(null);
  const [publishPassphrase, setPublishPassphrase] = useState('');
  const [publishBusy, setPublishBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [showRates, setShowRates] = useState(false);
  const rateTapCountRef = React.useRef(0);
  const rateTapTimerRef = React.useRef(null);
  const RATE_TAP_TARGET = 7;

  function handleRatesTap() {
    rateTapCountRef.current += 1;
    if (rateTapTimerRef.current) clearTimeout(rateTapTimerRef.current);
    rateTapTimerRef.current = setTimeout(() => { rateTapCountRef.current = 0; }, 1200);
    if (rateTapCountRef.current >= RATE_TAP_TARGET) {
      rateTapCountRef.current = 0;
      setShowRates(true);
    }
  }

  useEffect(() => { loadAll(); }, []);

  // Follow the OS setting live while the person is on "System".
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = e => setSystemDark(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  const isDark = themePref === 'dark' || (themePref === 'system' && systemDark);

  // The app itself is a centered column — on a real browser (wider than the
  // column, unlike the Claude preview) the page behind it would otherwise stay
  // white regardless of theme, since the .theme-dark class only reaches the
  // column, not the page itself.
  useEffect(() => {
    const bg = isDark ? '#0B0B10' : '#F2F2F6';
    document.documentElement.style.background = bg;
    document.body.style.background = bg;
  }, [isDark]);
  const rootClass = isDark ? 'theme-dark' : '';

  async function changeTheme(pref) {
    setThemePref(pref);
    await tryWrite('theme', pref, false);
  }
  useEffect(() => { if (tab !== 'settings') setShowRates(false); }, [tab]);

  function flashToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  }

  async function safeGet(key, shared) {
    try { return await window.storage.get(key, shared); } catch (e) { return null; }
  }

  async function loadAll() {
    setLoading(true);
    const themeRow = await safeGet('theme', false);
    if (themeRow) { try { setThemePref(JSON.parse(themeRow.value)); } catch (e) {} }

    const p = await safeGet('profile', false);
    if (p) { try { setProfile(JSON.parse(p.value)); } catch (e) {} }

    const c = await safeGet('categories', false);
    if (c) {
      try {
        const parsed = migrateCategories(JSON.parse(c.value));
        setCategories(parsed);
        if (JSON.stringify(parsed) !== c.value) { try { await window.storage.set('categories', JSON.stringify(parsed), false); } catch (e) {} }
      } catch (e) {}
    } else { try { await window.storage.set('categories', JSON.stringify(DEFAULT_CATEGORIES), false); } catch (e) {} }

    const sp = await safeGet('spiffs', false);
    let spiffsData = [];
    if (sp) { try { spiffsData = JSON.parse(sp.value); setSpiffs(spiffsData); } catch (e) {} }

    const gl = await safeGet('goals', false);
    let goalsData = {};
    if (gl) { try { goalsData = JSON.parse(gl.value); setGoals(goalsData); } catch (e) {} }

    const co = await safeGet('commissions', false);
    let commissionsData = [];
    if (co) { try { commissionsData = JSON.parse(co.value); setCommissions(commissionsData); } catch (e) {} }

    // One-time correction for renamed categories (see CATEGORY_RENAMES).
    const renamed = renameSavedCategories(commissionsData, goalsData, spiffsData);
    if (renamed.changed) {
      setCommissions(renamed.commissions);
      setGoals(renamed.goals);
      setSpiffs(renamed.spiffs);
      await tryWrite('commissions', renamed.commissions, false);
      await tryWrite('goals', renamed.goals, false);
      await tryWrite('spiffs', renamed.spiffs, false);
    }

    const cu = await safeGet('customers', false);
    if (cu) { try { setCustomers(JSON.parse(cu.value)); } catch (e) {} }

    // Pull the shared Monthly Goals & SPIFFs, if configured. Failing quietly
    // here is intentional — no internet or no Supabase setup yet shouldn't
    // block the app or wipe out whatever goals/SPIFFs are already saved locally.
    if (SUPABASE_READY) {
      setTeamConfigStatus('syncing');
      try {
        const row = await fetchTeamConfig();
        if (row) {
          if (row.goals && typeof row.goals === 'object') { setGoals(row.goals); await tryWrite('goals', row.goals, false); }
          if (Array.isArray(row.spiffs)) { setSpiffs(row.spiffs); await tryWrite('spiffs', row.spiffs, false); }
          setTeamConfigUpdatedAt(row.updated_at || null);
        }
        setTeamConfigStatus('synced');
      } catch (e) {
        setTeamConfigStatus('error');
        setTeamConfigError(e?.message || 'Could not reach team config.');
      }
    }

    hydratedRef.current = true;
    setLoading(false);
  }


  const storageOk = typeof window !== 'undefined' && window.storage && typeof window.storage.set === 'function';

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Writes a key and reports success/failure instead of throwing. Retries once on
  // transient failures (e.g. "Unexpected response type") before giving up.
  async function tryWrite(key, value, shared) {
    if (!storageOk) return { ok: false, why: 'Storage is not available in this session.' };
    const delays = [400, 800, 1500]; // a few tries with backoff before giving up
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await window.storage.set(key, JSON.stringify(value), shared);
        if (res === null || res === undefined) {
          if (attempt < delays.length) { await wait(delays[attempt]); continue; }
          return { ok: false, why: 'The save did not go through.' };
        }
        return { ok: true };
      } catch (e) {
        if (attempt < delays.length) { await wait(delays[attempt]); continue; }
        return { ok: false, why: (e && e.message) ? e.message : 'Unknown storage error.' };
      }
    }
    return { ok: false, why: 'Unknown storage error.' };
  }

  async function persist(key, value, shared = false) {
    const res = await tryWrite(key, value, shared);
    if (!res.ok) flashToast(`Didn't sync: ${res.why}`);
    return res.ok;
  }

  // Whole-app backup as a downloadable JSON file. Pure client-side (Blob + anchor
  // download) — no network call, so it works regardless of any sandbox restriction.
  function exportBackup() {
    setBackupError('');
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'My TMO Tracker',
      version: 1,
      profile, commissions, customers, categories, spiffs, goals,
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `tmo-tracker-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      flashToast('Backup saved');
    } catch (e) {
      setBackupError("Couldn't create the backup file. Try again.");
    }
  }

  async function importBackup(file) {
    if (!file) return;
    setBackupError('');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('bad file');

      if (Array.isArray(data.commissions)) { setCommissions(data.commissions); await tryWrite('commissions', data.commissions, false); }
      if (Array.isArray(data.customers)) { setCustomers(data.customers); await tryWrite('customers', data.customers, false); }
      if (Array.isArray(data.categories)) {
        const cats = migrateCategories(data.categories);
        setCategories(cats);
        await tryWrite('categories', cats, false);
      }
      if (Array.isArray(data.spiffs)) { setSpiffs(data.spiffs); await tryWrite('spiffs', data.spiffs, false); }
      if (data.goals && typeof data.goals === 'object') { setGoals(data.goals); await tryWrite('goals', data.goals, false); }
      if (data.profile?.name) { setProfile(data.profile); await tryWrite('profile', data.profile, false); }

      flashToast('Backup restored');
    } catch (e) {
      setBackupError("That file doesn't look like a My TMO Tracker backup.");
    }
  }

  async function saveProfile(name) {
    const p = { name: name.trim() };
    setProfile(p);
    const res = await tryWrite('profile', p, false);
    if (res.ok) {
      setProfileError('');
    } else {
      setProfileError(`Your name didn't save, so you may need to re-enter it next time (${res.why}).`);
    }
  }

  async function setEmploymentTypePref(type) {
    const p = { ...(profile || {}), employmentType: type };
    setProfile(p);
    await persist('profile', p);
  }

  function switchUser() {
    setProfile(null);
    setNameInput('');
    setProfileError('');
    try { window.storage.delete('profile', false); } catch (e) {}
  }

  const myName = profile?.name;
  const employmentType = profile?.employmentType === 'partTime' ? 'partTime' : 'fullTime';

  /* ---- commissions CRUD ---- */
  async function addCommission(entry) {
    const next = [{ ...entry, id: uid(), repName: myName, createdAt: new Date().toISOString() }, ...commissions];
    setCommissions(next);
    const ok = await persist('commissions', next);
    setShowSaleModal(false);
    setSaleModalPlan(null);
    if (ok) flashToast('Transaction logged');
  }
  async function deleteCommission(id) {
    const next = commissions.filter(c => c.id !== id);
    setCommissions(next);
    await persist('commissions', next);
  }

  /* ---- customers CRUD ---- */
  async function addCustomer(entry) {
    const next = [{ ...entry, id: uid(), createdAt: new Date().toISOString() }, ...customers];
    setCustomers(next);
    const ok = await persist('customers', next);
    setCustomerModal({ open: false, initial: null, id: null });
    if (ok) flashToast('Customer added');
  }
  async function editCustomer(id, patch) {
    const next = customers.map(c => c.id === id ? { ...c, ...patch } : c);
    setCustomers(next);
    const ok = await persist('customers', next);
    setCustomerModal({ open: false, initial: null, id: null });
    if (ok) flashToast('Customer updated');
  }
  async function deleteCustomer(id) {
    const next = customers.filter(c => c.id !== id);
    setCustomers(next);
    await persist('customers', next);
  }
  async function quickAddCustomer(name) {
    const newCustomer = {
      id: uid(), name: name.trim(), phone: '', email: '', notes: '',
      nextFollowUp: '', createdAt: new Date().toISOString(),
    };
    const next = [newCustomer, ...customers];
    setCustomers(next);
    await persist('customers', next);
    return newCustomer;
  }

  /* ---- categories ---- */
  async function addCategory() {
    const name = newCat.name.trim();
    if (!name || categories.some(c => c.name === name)) return;
    const rateNum = Number(newCat.rate) || 0;
    const rate = newCat.calcType === 'percentMRC' || newCat.calcType === 'percentPrice' ? rateNum / 100 : rateNum;
    const next = [...categories, { name, calcType: newCat.calcType, rate }];
    setCategories(next);
    await persist('categories', next);
    setNewCat({ name: '', calcType: 'manual', rate: '' });
  }
  async function removeCategory(name) {
    const next = categories.filter(c => c.name !== name);
    setCategories(next);
    await persist('categories', next);
  }

  async function addSpiff(draft) {
    const label = draft.label.trim();
    const amount = Number(draft.amount);
    if (!label || !draft.categoryName || !amount) return false;
    const next = [...spiffs, {
      id: uid(), label, categoryName: draft.categoryName,
      planName: draft.planName || null, amount, active: true,
    }];
    setSpiffs(next);
    await persist('spiffs', next);
    return true;
  }
  async function removeSpiff(id) {
    const next = spiffs.filter(s => s.id !== id);
    setSpiffs(next);
    await persist('spiffs', next);
  }
  async function toggleSpiff(id) {
    const next = spiffs.map(s => (s.id === id ? { ...s, active: !s.active } : s));
    setSpiffs(next);
    await persist('spiffs', next);
  }

  async function addGoal(monthKey, type, draft) {
    const name = draft.name.trim();
    const target = Number(draft.target);
    const categoryNames = draft.categoryNames || [];
    const goalType = draft.goalType === 'percent' || draft.goalType === 'revenuePerUnit' ? draft.goalType : 'units';
    const needsBase = goalType !== 'units';
    const baseCategoryNames = draft.baseCategoryNames || [];
    if (!name || !target || !categoryNames.length) return false;
    if (needsBase && !baseCategoryNames.length) return false;
    const monthEntry = goals[monthKey] || { fullTime: [], partTime: [] };
    const goalEntry = { id: uid(), name, target, goalType, categoryNames };
    if (needsBase) goalEntry.baseCategoryNames = baseCategoryNames;
    const nextMonthEntry = { ...monthEntry, [type]: [...(monthEntry[type] || []), goalEntry] };
    const next = { ...goals, [monthKey]: nextMonthEntry };
    setGoals(next);
    await persist('goals', next);
    return true;
  }

  async function publishGoalsAndSpiffs() {
    if (!SUPABASE_READY) { setTeamConfigError('Team config isn\'t set up yet — add your Supabase URL and key in the code.'); return; }
    setPublishBusy(true);
    setTeamConfigError('');
    try {
      const row = await fetchTeamConfig();
      if (!row) throw new Error('Team config row not found — did you run team-config-setup.sql?');
      if ((row.passphrase || '') !== publishPassphrase) throw new Error('That passphrase doesn\'t match.');
      await publishTeamConfig(goals, spiffs);
      setTeamConfigStatus('synced');
      setTeamConfigUpdatedAt(new Date().toISOString());
      flashToast('Published — every device will pick this up next time they open the app');
    } catch (e) {
      setTeamConfigStatus('error');
      setTeamConfigError(e?.message || 'Publish failed.');
    }
    setPublishBusy(false);
  }

  async function updateGoal(monthKey, type, id, draft) {
    const name = draft.name.trim();
    const target = Number(draft.target);
    const categoryNames = draft.categoryNames || [];
    const goalType = draft.goalType === 'percent' || draft.goalType === 'revenuePerUnit' ? draft.goalType : 'units';
    const needsBase = goalType !== 'units';
    const baseCategoryNames = draft.baseCategoryNames || [];
    if (!name || !target || !categoryNames.length) return false;
    if (needsBase && !baseCategoryNames.length) return false;
    const monthEntry = goals[monthKey];
    if (!monthEntry) return false;
    const updated = { id, name, target, goalType, categoryNames };
    if (needsBase) updated.baseCategoryNames = baseCategoryNames;
    const nextList = (monthEntry[type] || []).map(g => (g.id === id ? updated : g));
    const next = { ...goals, [monthKey]: { ...monthEntry, [type]: nextList } };
    setGoals(next);
    await persist('goals', next);
    return true;
  }

  async function removeGoal(monthKey, type, id) {
    const monthEntry = goals[monthKey];
    if (!monthEntry) return;
    const next = { ...goals, [monthKey]: { ...monthEntry, [type]: (monthEntry[type] || []).filter(g => g.id !== id) } };
    setGoals(next);
    await persist('goals', next);
  }

  async function copyGoalsFromPreviousMonth(monthKey, type) {
    const { list, sourceMonth } = goalsForMonth(goals, monthKey, type);
    if (!sourceMonth || sourceMonth === monthKey || !list.length) return;
    const copied = list.map(g => ({ ...g, id: uid() }));
    const monthEntry = goals[monthKey] || { fullTime: [], partTime: [] };
    const next = { ...goals, [monthKey]: { ...monthEntry, [type]: copied } };
    setGoals(next);
    await persist('goals', next);
  }

  /* ---- derived ---- */
  const ranges = useMemo(() => {
    const now = new Date();
    return { today: startOfDay(now), week: startOfWeek(now), month: startOfMonth(now), year: startOfYear(now) };
  }, []);

  function sumSince(entries, repName, since) {
    return entries
      .filter(c => (!repName || c.repName === repName) && new Date(c.date) >= since)
      .reduce((s, c) => s + Number(c.amount || 0), 0);
  }

  const myTotals = useMemo(() => ({
    today: sumSince(commissions, myName, ranges.today),
    week: sumSince(commissions, myName, ranges.week),
    month: sumSince(commissions, myName, ranges.month),
    year: sumSince(commissions, myName, ranges.year),
  }), [commissions, myName, ranges]);

  const heroValue = useCountUp(myTotals[statPeriod] || 0);

  // Signal strength: how this period stacks up against a reasonable target for it,
  // so the bars mean something rather than being decoration.
  const heroStrength = useMemo(() => {
    const targets = { today: 150, week: 750, month: 3000, year: 36000 };
    const pct = (myTotals[statPeriod] || 0) / targets[statPeriod];
    return Math.max(0, Math.min(5, Math.ceil(pct * 5)));
  }, [myTotals, statPeriod]);

  const last7 = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dStart = startOfDay(d);
      const dEnd = new Date(dStart); dEnd.setDate(dEnd.getDate() + 1);
      const total = commissions
        .filter(c => c.repName === myName && new Date(c.date) >= dStart && new Date(c.date) < dEnd)
        .reduce((s, c) => s + Number(c.amount || 0), 0);
      days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' })[0], total: Math.round(total * 100) / 100 });
    }
    return days;
  }, [commissions, myName]);

  const mySales = useMemo(
    () => commissions.filter(c => c.repName === myName).sort((a, b) => new Date(b.date) - new Date(a.date)),
    [commissions, myName]
  );

  const monthSales = useMemo(
    () => mySales.filter(s => (s.date || '').slice(0, 7) === saleMonth),
    [mySales, saleMonth]
  );
  const monthTotal = useMemo(() => monthSales.reduce((s, c) => s + Number(c.amount || 0), 0), [monthSales]);

  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  async function copyMonthSummary() {
    const body = [];
    let spiffTotal = 0;
    monthSales.forEach(s => {
      const items = Array.isArray(s.items) && s.items.length ? s.items : null;
      const cust = customers.find(c => c.id === s.customerId);
      body.push(`${fmtDateNice(s.date)}\t${cust ? cust.name : 'No customer'}\t${fmtMoney(s.amount)}`);
      if (items) {
        items.forEach(it => {
          const q = Number(it.qty) || 1;
          const bits = [];
          if (it.planName) bits.push(it.planName);
          else if (it.baseValue != null) bits.push(`${fmtMoneyPlain(it.baseValue)} each`);
          if (q > 1) bits.push(`Qty ${q}`);
          if (it.spiffAmount > 0) { bits.push(`+${fmtMoneyPlain(it.spiffAmount)} SPIFF`); spiffTotal += it.spiffAmount; }
          const d = bits.length ? ` (${bits.join(', ')})` : '';
          body.push(`    · ${it.category}${d}\t${fmtMoney(it.amount)}`);
        });
      } else {
        body.push(`    · ${s.category}\t${fmtMoney(s.amount)}`);
      }
    });
    const lines = [
      `My TMO Tracker — Commission Summary`,
      `${monthLabel(saleMonth)} · ${myName}`,
      '-'.repeat(38),
      ...body,
      '-'.repeat(38),
      `Total: ${fmtMoney(monthTotal)} (${monthSales.length} transaction${monthSales.length === 1 ? '' : 's'})`,
      ...(spiffTotal > 0 ? [`Includes ${fmtMoney(spiffTotal)} in SPIFFs`] : []),
    ];
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      flashToast('Copied — paste it anywhere to compare');
    } catch (e) {
      setReconcileText(text);
    }
  }

  const customerIdsWithSales = useMemo(
    () => new Set(commissions.filter(c => c.customerId).map(c => c.customerId)),
    [commissions]
  );

  const customerStats = useMemo(() => {
    const map = {};
    commissions.forEach(c => {
      if (!c.customerId) return;
      if (!map[c.customerId]) map[c.customerId] = { total: 0, count: 0 };
      map[c.customerId].total += Number(c.amount || 0);
      map[c.customerId].count += 1;
    });
    return map;
  }, [commissions]);

  const visibleCustomers = useMemo(() => {
    let list = customers;
    if (customerSearch.trim()) {
      const q = customerSearch.toLowerCase();
      list = list.filter(c => (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.email || '').toLowerCase().includes(q));
    }
    const rank = (c) => (customerIdsWithSales.has(c.id) ? 0 : c.nextFollowUp ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || ''));
  }, [customers, customerSearch, customerIdsWithSales]);

  const planEligibilities = useMemo(() => Array.from(new Set(PLANS.map(p => p.eligibility))), []);
  const visiblePlans = useMemo(() => {
    let list = PLANS;
    if (planFilter) list = list.filter(p => p.eligibility === planFilter);
    return list;
  }, [planFilter]);

  /* -------------------------------- rendering -------------------------------- */

  if (loading) {
    return (
      <div className={`app-shell ${rootClass}`} style={{ ...styles.app, alignItems: 'center', justifyContent: 'center' }}>
        <style>{GLOBAL_CSS}</style>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <SignalBars level={5} height={28} barWidth={6} gap={4} dim="var(--border)" />
          </div>
          <div className="font-display" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-soft)' }}>My TMO Tracker</div>
        </div>
      </div>
    );
  }

  // Config not filled in yet — tell the owner what to do rather than failing silently.
  // Config not filled in yet — tell the owner what to do rather than failing silently.
  // Config not filled in yet — tell the owner what to do rather than failing silently.
  if (!profile) {
    return (
      <div className={`app-shell ${rootClass}`} style={{ ...styles.app, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <style>{GLOBAL_CSS}</style>
        <div style={{ width: '100%', maxWidth: 340 }} className="rise">
          <div style={{ marginBottom: 18 }}>
            <SignalBars level={5} height={30} barWidth={7} gap={4} dim="var(--border)" />
          </div>
          <div className="font-display" style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.02, marginBottom: 8 }}>
            My TMO<br /><span style={{ color: 'var(--accent)' }}>Tracker</span>
          </div>
          <div style={{ color: 'var(--ink-soft)', fontSize: 14.5, marginBottom: 26, lineHeight: 1.5 }}>
            Know what you've earned. As you earn it.
          </div>
          <Field label="What's your name?">
            <input
              value={nameInput} onChange={e => setNameInput(e.target.value)} style={styles.input}
              placeholder="e.g. Jordan Lee" onKeyDown={e => e.key === 'Enter' && nameInput.trim() && saveProfile(nameInput)}
            />
          </Field>
          <button
            className="press"
            style={{ ...styles.primaryBtn, opacity: nameInput.trim() ? 1 : 0.45 }}
            disabled={!nameInput.trim()} onClick={() => saveProfile(nameInput)}
          >
            Start tracking
          </button>
          {profileError && (
            <div style={{ fontSize: 12, color: '#DC2626', marginTop: 12, lineHeight: 1.5 }}>{profileError}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${rootClass}`} style={styles.app}>
      <style>{GLOBAL_CSS}</style>

      {/* header — hidden on Settings, since that tab has its own title */}
      {tab === 'dashboard' && (
        <div style={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <SignalBars level={5} height={20} barWidth={4} gap={2.5} dim="var(--border)" animate={false} />
            <div style={{ minWidth: 0 }}>
              <div className="font-display" style={{ fontSize: 16.5, fontWeight: 800, lineHeight: 1.1 }}>
                Hey, {myName.split(' ')[0]}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={styles.main}>
        {tab === 'dashboard' && (
          <div>
            <div style={styles.pillRow}>
              {['today', 'week', 'month', 'year'].map(p => (
                <button key={p} onClick={() => setStatPeriod(p)} style={statPeriod === p ? styles.pillActive : styles.pill}>
                  {p === 'today' ? 'Today' : p === 'week' ? 'Week' : p === 'month' ? 'Month' : 'Year'}
                </button>
              ))}
            </div>

            <div style={styles.heroCard} className="rise">
              <div style={styles.heroGlow} />
              <div style={{ position: 'relative', zIndex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.09em', opacity: 0.6 }}>
                    {statPeriod === 'today' ? 'EARNED TODAY' : statPeriod === 'week' ? 'EARNED THIS WEEK' : statPeriod === 'month' ? 'EARNED THIS MONTH' : 'EARNED THIS YEAR'}
                  </div>
                  <SignalBars level={heroStrength} height={20} barWidth={4} gap={3} color="var(--accent-2)" />
                </div>
                <div className="font-display tabular" style={{ fontSize: 46, fontWeight: 900, margin: '8px 0 2px', letterSpacing: '-0.04em', lineHeight: 1 }}>
                  {fmtMoney(heroValue)}
                </div>
              </div>
            </div>

            <div style={styles.grid3}>
              {['today', 'week', 'month', 'year'].filter(p => p !== statPeriod).map((p, i) => (
                <button
                  key={p} onClick={() => setStatPeriod(p)}
                  className="rise press" style={{ ...styles.statCard, animationDelay: `${80 + i * 60}ms` }}
                >
                  <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{p}</div>
                  <div className="font-display tabular" style={{ fontSize: 16.5, fontWeight: 800, marginTop: 3, color: 'var(--ink)' }}>{fmtMoney(myTotals[p])}</div>
                </button>
              ))}
            </div>

            <div style={styles.card} className="rise">
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                <TrendingUp size={15} color="var(--accent)" />
                <div className="font-display" style={{ fontWeight: 800, fontSize: 13.5 }}>Last 7 days</div>
              </div>
              <div style={{ height: 110 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={last7} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent-2)" />
                        <stop offset="100%" stopColor="var(--accent)" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--ink-faint)' }} />
                    <Tooltip
                      cursor={{ fill: 'rgba(226,0,116,0.06)' }}
                      formatter={(v) => fmtMoney(v)}
                      contentStyle={{
                        borderRadius: 12, border: '1px solid var(--border)', fontSize: 12,
                        boxShadow: 'var(--shadow-md)', background: 'var(--surface)', color: 'var(--ink)',
                      }}
                      labelStyle={{ color: 'var(--ink)', fontWeight: 700, marginBottom: 2 }}
                      itemStyle={{ color: 'var(--ink)' }}
                    />
                    <Bar dataKey="total" fill="url(#barGrad)" radius={[6, 6, 0, 0]} animationDuration={620} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '22px 2px 10px' }}>
              <div className="font-display" style={{ fontWeight: 800, fontSize: 13.5 }}>Recent sales</div>
              <button onClick={() => setTab('sales')} style={styles.linkBtn}>See all <ChevronRight size={13} /></button>
            </div>
            {mySales.length === 0 ? (
              <EmptyState icon={DollarSign} title="No Sales" />
            ) : (
              mySales.slice(0, 5).map((s, i) => (
                <div key={s.id} className="rise" style={{ animationDelay: `${i * 45}ms` }}>
                  <SaleRow sale={s} customers={customers} />
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'sales' && (
          <div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 18, marginTop: 14, marginBottom: 12 }}>Your sales</div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <input
                type="month" value={saleMonth} onChange={e => setSaleMonth(e.target.value)}
                style={{ ...styles.input, flex: 1 }}
              />
              <button
                style={{ ...styles.secondaryBtn, opacity: monthSales.length === 0 ? 0.5 : 1 }}
                onClick={copyMonthSummary} disabled={monthSales.length === 0}
              >
                Copy summary
              </button>
            </div>

            <div style={{ ...styles.card, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} className="rise">
              <div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', fontWeight: 600 }}>{monthLabel(saleMonth)}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{monthSales.length} transaction{monthSales.length === 1 ? '' : 's'}</div>
              </div>
              <div className="font-display tabular" style={{ fontSize: 20, fontWeight: 800 }}>{fmtMoney(monthTotal)}</div>
            </div>

            {reconcileText && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 6 }}>
                  Couldn't copy automatically — select and copy the text below:
                </div>
                <textarea
                  readOnly value={reconcileText} rows={6}
                  style={{ ...styles.input, fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }}
                  onFocus={e => e.target.select()}
                />
                <button style={{ ...styles.linkBtn, marginTop: 6 }} onClick={() => setReconcileText('')}>Dismiss</button>
              </div>
            )}

            {monthSales.length === 0 ? (
              <EmptyState icon={DollarSign} title="No Sales" />
            ) : (
              monthSales.map((s, i) => (
                <div key={s.id} className="rise" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <SaleRow sale={s} customers={customers} onDelete={() => deleteCommission(s.id)} />
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'customers' && (
          <div>
            <div style={{ position: 'relative', marginTop: 14, marginBottom: 14 }}>
              <Search size={16} style={{ position: 'absolute', left: 12, top: 12, color: 'var(--ink-faint)' }} />
              <input
                value={customerSearch} onChange={e => setCustomerSearch(e.target.value)}
                placeholder="Search customers" style={{ ...styles.input, paddingLeft: 34 }}
              />
            </div>
            {visibleCustomers.length === 0 ? (
              <EmptyState icon={Users} title="No Customers" />
            ) : (
              visibleCustomers.map((c, i) => {
                const stats = customerStats[c.id];
                const tag = relationshipTag(c, !!stats);
                return (
                  <div
                    key={c.id} style={{ ...styles.customerRow, animationDelay: `${Math.min(i, 8) * 40}ms` }}
                    className="lift press rise"
                    onClick={() => setCustomerModal({ open: true, initial: c, id: c.id })}
                  >
                    <Avatar name={c.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                        {stats
                          ? `${fmtMoney(stats.total)} · ${stats.count} sale${stats.count === 1 ? '' : 's'}`
                          : c.nextFollowUp
                            ? `Follow up ${fmtDateNice(c.nextFollowUp)}`
                            : (c.phone || c.email || 'No contact info')}
                      </div>
                    </div>
                    <Badge tag={tag} />
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === 'goals' && (
          <div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 18, marginTop: 14, marginBottom: 4, textAlign: 'center' }}>Monthly Goals</div>
            <MonthStepper value={goalMonth} onChange={setGoalMonth} label={monthLabel(goalMonth)} />

            {(() => {
              const { list: goalList, sourceMonth } = goalsForMonth(goals, goalMonth, employmentType);
              if (!goalList.length) {
                return (
                  <EmptyState
                    icon={TrendingUp}
                    title="No Goals Set"
                  />
                );
              }
              const rows = goalList.map(g => {
                const catNames = goalCategoryNames(g);
                const prog = computeGoalProgress(g, commissions, goalMonth);
                return { ...g, catNames, ...prog };
              });
              const fmtVal = (r, n) => (r.isRevenuePerUnit ? fmtMoneyPlain(n) : `${n}${r.isPercent ? '%' : ''}`);
              return (
                <>
                  {sourceMonth && sourceMonth !== goalMonth && (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 12, lineHeight: 1.5 }}>
                      Nothing posted for {monthLabel(goalMonth)} yet — showing {monthLabel(sourceMonth)}'s goals.
                    </div>
                  )}

                  {rows.map((r, i) => (
                    <div key={r.id} style={{ ...styles.planCard, animationDelay: `${Math.min(i, 8) * 35}ms` }} className="lift rise">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 14.5 }}>{r.name}</div>
                        {r.met && (
                          <span style={{ ...styles.promoBadge, flexShrink: 0 }}><Check size={11} strokeWidth={3} style={{ marginRight: 3 }} />Met</span>
                        )}
                      </div>
                      <div style={styles.goalTrack}>
                        <div style={{ ...styles.goalFill, width: `${r.pct}%`, background: r.met ? 'var(--positive)' : 'var(--accent)' }} />
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <span className="tabular" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-soft)' }}>
                          {fmtVal(r, r.achieved)} / {fmtVal(r, r.target)}
                        </span>
                      </div>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        )}

        {tab === 'plans' && (
          <div>
            <div style={{ display: 'flex', gap: 6, marginTop: 14, marginBottom: 14, overflowX: 'auto' }}>
              <button onClick={() => setPlanSubTab('phone')} style={planSubTab === 'phone' ? styles.pillActiveSm : styles.pillSm}>Phone Plans</button>
              <button onClick={() => setPlanSubTab('internet')} style={planSubTab === 'internet' ? styles.pillActiveSm : styles.pillSm}>Home Internet</button>
              <button onClick={() => setPlanSubTab('fiber')} style={planSubTab === 'fiber' ? styles.pillActiveSm : styles.pillSm}>Fiber</button>
              <button onClick={() => setPlanSubTab('watch')} style={planSubTab === 'watch' ? styles.pillActiveSm : styles.pillSm}>Watch</button>
              <button onClick={() => setPlanSubTab('tablet')} style={planSubTab === 'tablet' ? styles.pillActiveSm : styles.pillSm}>Tablet</button>
            </div>

            {planSubTab === 'phone' && (
              <>
                <div style={styles.sectionDivider} />
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto' }}>
                  {planEligibilities.map(e => (
                    <button key={e} onClick={() => setPlanFilter(e)} style={planFilter === e ? styles.pillActiveSm : styles.pillSm}>{e}</button>
                  ))}
                </div>

            {visiblePlans.length === 0 ? (
              <EmptyState icon={Smartphone} title="No plans found" sub="Try a different search or filter." />
            ) : (
              visiblePlans.map((plan, i) => {
                const isOpen = expandedPlan === plan.name;
                return (
                  <div key={plan.name} style={{ ...styles.planCard, animationDelay: `${Math.min(i, 8) * 35}ms` }} className="lift rise">
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }} onClick={() => setExpandedPlan(isOpen ? null : plan.name)}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14.5 }}>{plan.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{plan.data}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {plan.eligibility !== 'Standard' && (
                            <span style={styles.planBadge}>{plan.verification && <ShieldCheck size={11} style={{ marginRight: 3 }} />}{plan.eligibility}</span>
                          )}
                          {plan.thirdLineFree && (
                            <span style={styles.promoBadge}>3rd line free</span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', textDecoration: 'line-through' }}>{fmtMoneyPlain(plan.tiers[0][1])}</div>
                        <div className="font-display tabular" style={{ fontWeight: 800, fontSize: 15, color: 'var(--positive)' }}>{fmtMoneyPlain(planPriceWithAutopay(plan, plan.tiers[0][0]))}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>w/ AutoPay · {plan.tiers[0][0]} line{plan.tiers[0][0] > 1 ? 's' : ''}</div>
                        <ChevronDown size={15} style={{ marginTop: 4, transform: isOpen ? 'rotate(180deg)' : 'none', color: 'var(--ink-faint)' }} />
                      </div>
                    </div>

                    {isOpen && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                        {plan.thirdLineFree && (
                          <div style={styles.promoCallout}>
                            <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 2 }}>Promo: 3rd line free</div>
                            <div style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                              At exactly 3 lines w/ AutoPay: {fmtMoneyPlain(planPriceWithAutopay(plan, 3, true))} normally → {fmtMoneyPlain(planPriceWithAutopay(plan, 3))} with this promo. Limited-time offer; doesn't apply at other line counts and may not stack with other promos.
                            </div>
                          </div>
                        )}
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Price with AutoPay (recommended quote)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                          {plan.tiers.map(([lines, price]) => (
                            <div key={lines} style={lines === 3 && plan.thirdLineFree ? styles.tierChipPromo : styles.tierChip}>
                              {lines === 3 && plan.thirdLineFree && (
                                <span style={{ color: 'var(--ink-faint)', textDecoration: 'line-through', marginRight: 4 }}>{fmtMoneyPlain(planPriceWithAutopay(plan, 3, true))}</span>
                              )}
                              <span style={{ fontWeight: 700, color: 'var(--positive)' }}>{fmtMoneyPlain(planPriceWithAutopay(plan, lines))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · {lines} line{lines > 1 ? 's' : ''}{lines === 3 && plan.thirdLineFree ? ' (promo)' : ''}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 6 }}>List price (without AutoPay)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                          {plan.tiers.map(([lines, price]) => (
                            <div key={lines} style={lines === 3 && plan.thirdLineFree ? styles.tierChipPromo : styles.tierChip}>
                              {lines === 3 && plan.thirdLineFree && (
                                <span style={{ color: 'var(--ink-faint)', textDecoration: 'line-through', marginRight: 4 }}>{fmtMoneyPlain(price)}</span>
                              )}
                              <span style={{ fontWeight: 700 }}>{fmtMoneyPlain(listPriceForLines(plan, lines))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · {lines} line{lines > 1 ? 's' : ''}{lines === 3 && plan.thirdLineFree ? ' (promo)' : ''}</span>
                            </div>
                          ))}
                          {plan.extraLine?.map(([min, max, per], i) => (
                            <div key={i} style={styles.tierChip}>
                              <span style={{ fontWeight: 700 }}>+{fmtMoneyPlain(per)}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · line{max > min ? 's' : ''} {min}{max > min ? `–${max}` : ''}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
                          AutoPay saves $5/line/month (up to 8 lines, max $40) with an eligible bank account or debit card.
                        </div>
                        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                          {plan.highlights.map((h, i) => <li key={i}>{h}</li>)}
                        </ul>
                        <button
                          style={styles.secondaryBtn}
                          onClick={() => { setSaleModalPlan({ plan, lines: plan.thirdLineFree ? 3 : plan.tiers[0][0] }); setShowSaleModal(true); }}
                        >
                          <DollarSign size={14} style={{ marginRight: 6 }} /> Log this sale
                        </button>
                      </div>
                    )}
                  </div>
                );
                  })
                )}
              </>
            )}

            {planSubTab === 'internet' && (
              <>
                {HOME_INTERNET_PLANS.map((p, i) => {
                  const isOpen = expandedPlan === p.name;
                  return (
                    <div key={p.name} style={{ ...styles.planCard, animationDelay: `${i * 35}ms` }} className="lift rise">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }} onClick={() => setExpandedPlan(isOpen ? null : p.name)}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{p.speed}</div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', textDecoration: 'line-through' }}>{fmtMoneyPlain(p.basePrice)}</div>
                          <div className="font-display tabular" style={{ fontWeight: 800, fontSize: 15, color: 'var(--positive)' }}>{fmtMoneyPlain(homeInternetPriceWithAutopay(p, false))}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>w/ AutoPay</div>
                          <ChevronDown size={15} style={{ marginTop: 4, transform: isOpen ? 'rotate(180deg)' : 'none', color: 'var(--ink-faint)' }} />
                        </div>
                      </div>

                      {isOpen && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Pricing</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700 }}>{fmtMoneyPlain(p.basePrice)}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · list price</span>
                            </div>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700, color: 'var(--positive)' }}>{fmtMoneyPlain(homeInternetPriceWithAutopay(p, false))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · w/ AutoPay</span>
                            </div>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700, color: 'var(--positive)' }}>{fmtMoneyPlain(homeInternetPriceWithAutopay(p, true))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · w/ AutoPay + voice line</span>
                            </div>
                          </div>
                          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                            {p.highlights.map((h, i2) => <li key={i2}>{h}</li>)}
                          </ul>
                          <button
                            style={styles.secondaryBtn}
                            onClick={() => { setSaleModalPlan({ homeInternetPlan: p }); setShowSaleModal(true); }}
                          >
                            <DollarSign size={14} style={{ marginRight: 6 }} /> Log this sale
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {planSubTab === 'fiber' && (
              <>
                {FIBER_PLANS.map((p, i) => {
                  const isOpen = expandedPlan === p.name;
                  return (
                    <div key={p.name} style={{ ...styles.planCard, animationDelay: `${i * 35}ms` }} className="lift rise">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }} onClick={() => setExpandedPlan(isOpen ? null : p.name)}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{p.speed}</div>
                          {p.promoAutopayPrice != null && (
                            <span style={{ ...styles.promoBadge, marginTop: 6, display: 'inline-block' }}>Limited-time price</span>
                          )}
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', textDecoration: 'line-through' }}>{fmtMoneyPlain(p.basePrice)}</div>
                          <div className="font-display tabular" style={{ fontWeight: 800, fontSize: 15, color: 'var(--positive)' }}>{fmtMoneyPlain(fiberPriceWithAutopay(p))}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>w/ AutoPay</div>
                          <ChevronDown size={15} style={{ marginTop: 4, transform: isOpen ? 'rotate(180deg)' : 'none', color: 'var(--ink-faint)' }} />
                        </div>
                      </div>

                      {isOpen && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Pricing</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700 }}>{fmtMoneyPlain(p.basePrice)}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · list price</span>
                            </div>
                            <div style={p.promoAutopayPrice != null ? styles.tierChipPromo : styles.tierChip}>
                              {p.promoAutopayPrice != null && (
                                <span style={{ color: 'var(--ink-faint)', textDecoration: 'line-through', marginRight: 4 }}>{fmtMoneyPlain(fiberPriceWithAutopay(p, true))}</span>
                              )}
                              <span style={{ fontWeight: 700, color: 'var(--positive)' }}>{fmtMoneyPlain(fiberPriceWithAutopay(p))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · w/ AutoPay{p.promoAutopayPrice != null ? ' (limited-time)' : ''}</span>
                            </div>
                          </div>
                          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                            {p.highlights.map((h, i2) => <li key={i2}>{h}</li>)}
                          </ul>
                          <button
                            style={styles.secondaryBtn}
                            onClick={() => { setSaleModalPlan({ fiberPlan: p }); setShowSaleModal(true); }}
                          >
                            <DollarSign size={14} style={{ marginRight: 6 }} /> Log this sale
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {planSubTab === 'watch' && (
              <>
                {WATCH_PLANS.map((p, i) => {
                  const isOpen = expandedPlan === p.name;
                  return (
                    <div key={p.name} style={{ ...styles.planCard, animationDelay: `${i * 35}ms` }} className="lift rise">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }} onClick={() => setExpandedPlan(isOpen ? null : p.name)}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{p.speed}</div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', textDecoration: 'line-through' }}>{fmtMoneyPlain(p.basePrice)}</div>
                          <div className="font-display tabular" style={{ fontWeight: 800, fontSize: 15, color: 'var(--positive)' }}>{fmtMoneyPlain(watchPriceWithAutopay(p))}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>w/ AutoPay</div>
                          <ChevronDown size={15} style={{ marginTop: 4, transform: isOpen ? 'rotate(180deg)' : 'none', color: 'var(--ink-faint)' }} />
                        </div>
                      </div>

                      {isOpen && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Pricing</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700 }}>{fmtMoneyPlain(p.basePrice)}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · list price</span>
                            </div>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700, color: 'var(--positive)' }}>{fmtMoneyPlain(watchPriceWithAutopay(p))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · w/ AutoPay</span>
                            </div>
                          </div>
                          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                            {p.highlights.map((h, i2) => <li key={i2}>{h}</li>)}
                          </ul>
                          <button
                            style={styles.secondaryBtn}
                            onClick={() => { setSaleModalPlan({ watchPlan: p }); setShowSaleModal(true); }}
                          >
                            <DollarSign size={14} style={{ marginRight: 6 }} /> Log this sale
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {planSubTab === 'tablet' && (
              <>
                {TABLET_PLANS.map((p, i) => {
                  const isOpen = expandedPlan === p.name;
                  return (
                    <div key={p.name} style={{ ...styles.planCard, animationDelay: `${i * 35}ms` }} className="lift rise">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }} onClick={() => setExpandedPlan(isOpen ? null : p.name)}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{p.speed}</div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', textDecoration: 'line-through' }}>{fmtMoneyPlain(p.basePrice)}</div>
                          <div className="font-display tabular" style={{ fontWeight: 800, fontSize: 15, color: 'var(--positive)' }}>{fmtMoneyPlain(tabletPriceWithAutopay(p))}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>w/ AutoPay</div>
                          <ChevronDown size={15} style={{ marginTop: 4, transform: isOpen ? 'rotate(180deg)' : 'none', color: 'var(--ink-faint)' }} />
                        </div>
                      </div>

                      {isOpen && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Pricing</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700 }}>{fmtMoneyPlain(p.basePrice)}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · list price</span>
                            </div>
                            <div style={styles.tierChip}>
                              <span style={{ fontWeight: 700, color: 'var(--positive)' }}>{fmtMoneyPlain(tabletPriceWithAutopay(p))}</span>
                              <span style={{ color: 'var(--ink-faint)' }}> · w/ AutoPay</span>
                            </div>
                          </div>
                          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                            {p.highlights.map((h, i2) => <li key={i2}>{h}</li>)}
                          </ul>
                          <button
                            style={styles.secondaryBtn}
                            onClick={() => { setSaleModalPlan({ tabletPlan: p }); setShowSaleModal(true); }}
                          >
                            <DollarSign size={14} style={{ marginRight: 6 }} /> Log this sale
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div>
            <div style={{ ...styles.card, marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar name={myName} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{myName}</div>
                  <div style={{ fontSize: 12, color: storageOk ? 'var(--positive)' : '#DC2626', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: storageOk ? 'var(--positive)' : '#DC2626', flexShrink: 0 }} />
                    {storageOk ? 'Online' : 'Offline'}
                  </div>
                </div>
                <button style={styles.iconBtnSm} onClick={switchUser} aria-label="Edit name">
                  <Edit2 size={15} />
                </button>
              </div>
              {profileError && (
                <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 10, lineHeight: 1.5 }}>{profileError}</div>
              )}
            </div>

            {/* employment type — determines which monthly goals apply */}
            <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 2px 8px' }}>Employment</div>
            <div style={styles.card}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { key: 'fullTime', label: 'Full-time' },
                  { key: 'partTime', label: 'Part-time' },
                ].map(opt => (
                  <button
                    key={opt.key} className="press"
                    style={{ ...(employmentType === opt.key ? styles.chipOn : styles.chip), flex: 1, textAlign: 'center' }}
                    onClick={() => setEmploymentTypePref(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* appearance */}
            <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 2px 8px' }}>Appearance</div>
            <div style={styles.card}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { key: 'light', label: 'Light' },
                  { key: 'dark', label: 'Dark' },
                  { key: 'system', label: 'System' },
                ].map(opt => (
                  <button
                    key={opt.key} className="press"
                    style={{ ...(themePref === opt.key ? styles.chipOn : styles.chip), flex: 1, textAlign: 'center' }}
                    onClick={() => changeTheme(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* cloud sync */}


            <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 2px 8px' }}>Backup & Restore</div>
            <div style={styles.card}>
              <div style={{ display: 'flex', gap: 8, marginBottom: backupError ? 10 : 0 }}>
                <button className="press" style={{ ...styles.secondaryBtn, flex: 1 }} onClick={exportBackup}>
                  <Upload size={14} style={{ marginRight: 6, transform: 'rotate(180deg)' }} /> Save backup
                </button>
                <button className="press" style={{ ...styles.secondaryBtn, flex: 1 }} onClick={() => backupFileRef.current?.click()}>
                  <Upload size={14} style={{ marginRight: 6 }} /> Restore backup
                </button>
                <input
                  ref={backupFileRef} type="file" accept="application/json,.json"
                  style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                  onChange={e => { importBackup(e.target.files?.[0]); e.target.value = ''; }}
                />
              </div>
              {backupError && (
                <div style={{ fontSize: 11.5, color: '#DC2626', lineHeight: 1.5 }}>{backupError}</div>
              )}
            </div>

            {showRates && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '22px 2px 10px' }}>
                  <Shield size={13} color="var(--accent)" />
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>
                    Administrator
                  </span>
                </div>

                <div style={styles.adminSectionLabel}><DollarSign size={13} />Commission Rates</div>
                <div style={styles.card}>
                  {categories.map(cat => (
                    <div key={cat.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)', gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{calcLabel(cat)}</div>
                      </div>
                      <button style={styles.iconBtnSm} onClick={() => removeCategory(cat.name)}><Trash2 size={14} /></button>
                    </div>
                  ))}

                  <div style={styles.adminSubLabel}>Add a category</div>
                  <input
                    value={newCat.name} onChange={e => setNewCat({ ...newCat, name: e.target.value })} placeholder="Category name"
                    style={{ ...styles.input, marginBottom: 8 }}
                  />
                  <select
                    value={newCat.calcType} onChange={e => setNewCat({ ...newCat, calcType: e.target.value })}
                    style={{ ...styles.input, marginBottom: 8 }}
                  >
                    <option value="percentMRC">% of monthly plan charge (MRC)</option>
                    <option value="percentPrice">% of sale price</option>
                    <option value="flat">Flat $ per unit</option>
                    <option value="manual">Enter amount manually each time</option>
                  </select>
                  {newCat.calcType !== 'manual' && (
                    <input
                      type="number" inputMode="decimal"
                      placeholder={newCat.calcType === 'flat' ? 'Flat amount, e.g. 8' : 'Percent, e.g. 50'}
                      value={newCat.rate} onChange={e => setNewCat({ ...newCat, rate: e.target.value })}
                      style={{ ...styles.input, marginBottom: 8 }}
                    />
                  )}
                  <button style={styles.secondaryBtn} onClick={addCategory}><Plus size={16} style={{ marginRight: 6 }} /> Add category</button>
                </div>

                <div style={styles.adminSectionLabel}><TrendingUp size={13} />Monthly Goals</div>
                <div style={styles.card}>
                  <MonthStepper
                    value={adminGoalMonth}
                    onChange={v => { setAdminGoalMonth(v); setEditingGoalId(null); setNewGoal({ name: '', target: '', goalType: 'units', categoryNames: [], baseCategoryNames: [] }); }}
                    label={monthLabel(adminGoalMonth)}
                  />
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    {[
                      { key: 'fullTime', label: 'Full-time' },
                      { key: 'partTime', label: 'Part-time' },
                    ].map(opt => (
                      <button
                        key={opt.key} className="press"
                        style={{ ...(adminGoalType === opt.key ? styles.chipOn : styles.chip), flex: 1, textAlign: 'center' }}
                        onClick={() => { setAdminGoalType(opt.key); setEditingGoalId(null); setNewGoal({ name: '', target: '', goalType: 'units', categoryNames: [], baseCategoryNames: [] }); }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {(() => {
                    const monthEntry = goals[adminGoalMonth];
                    const rows = (monthEntry && monthEntry[adminGoalType]) || [];
                    const { sourceMonth } = goalsForMonth(goals, adminGoalMonth, adminGoalType);
                    const canCopy = sourceMonth && sourceMonth !== adminGoalMonth;
                    return (
                      <>
                        {rows.length === 0 && (
                          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 12, lineHeight: 1.5 }}>
                            {canCopy
                              ? `Showing ${monthLabel(sourceMonth)}'s goals — nothing set for ${monthLabel(adminGoalMonth)} yet.`
                              : `No goals set for ${monthLabel(adminGoalMonth)} yet.`}
                          </div>
                        )}
                        {rows.map(g => (
                          <div key={g.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)', gap: 8, background: editingGoalId === g.id ? 'var(--accent-soft)' : 'transparent', borderRadius: editingGoalId === g.id ? 10 : 0 }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {g.name} <span style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                                  · target {g.goalType === 'revenuePerUnit' ? fmtMoneyPlain(g.target) : g.target}{g.goalType === 'percent' ? '%' : ''}
                                </span>
                              </div>
                              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {g.goalType === 'percent'
                                  ? `${formatGoalNames(goalCategoryNames(g))} out of ${formatGoalNames(g.baseCategoryNames)}`
                                  : g.goalType === 'revenuePerUnit'
                                  ? `${formatGoalNames(goalCategoryNames(g))} revenue per ${formatGoalNames(g.baseCategoryNames)}`
                                  : formatGoalNames(goalCategoryNames(g))}
                              </div>
                            </div>
                            <button
                              style={styles.iconBtnSm}
                              onClick={() => {
                                setEditingGoalId(g.id);
                                setNewGoal({
                                  name: g.name, target: String(g.target),
                                  goalType: g.goalType === 'percent' || g.goalType === 'revenuePerUnit' ? g.goalType : 'units',
                                  categoryNames: goalCategoryNames(g),
                                  baseCategoryNames: g.baseCategoryNames || [],
                                });
                              }}
                            >
                              <Edit2 size={14} />
                            </button>
                            <button style={styles.iconBtnSm} onClick={() => removeGoal(adminGoalMonth, adminGoalType, g.id)}><Trash2 size={14} /></button>
                          </div>
                        ))}

                        {canCopy && (
                          <button
                            style={{ ...styles.secondaryBtn, marginTop: rows.length ? 12 : 0, marginBottom: 12 }}
                            onClick={() => copyGoalsFromPreviousMonth(adminGoalMonth, adminGoalType)}
                          >
                            Copy {monthLabel(sourceMonth)}'s goals to {monthLabel(adminGoalMonth)}
                          </button>
                        )}
                      </>
                    );
                  })()}

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={styles.adminSubLabel}>{editingGoalId ? 'Edit goal' : 'Add a goal'}</div>
                    {editingGoalId && (
                      <button
                        style={{ ...styles.linkBtn, fontSize: 12, marginTop: 14 }}
                        onClick={() => { setEditingGoalId(null); setNewGoal({ name: '', target: '', goalType: 'units', categoryNames: [], baseCategoryNames: [] }); }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <input
                    value={newGoal.name} onChange={e => setNewGoal({ ...newGoal, name: e.target.value })}
                    placeholder="Goal name, e.g. Consumer Voice"
                    style={{ ...styles.input, marginBottom: 8 }}
                  />

                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    {[
                      { key: 'units', label: 'Units' },
                      { key: 'percent', label: 'Percentage' },
                      { key: 'revenuePerUnit', label: 'Revenue/unit' },
                    ].map(opt => (
                      <button
                        key={opt.key} className="press"
                        style={{ ...(newGoal.goalType === opt.key ? styles.chipOn : styles.chip), flex: 1, textAlign: 'center', fontSize: 12.5 }}
                        onClick={() => setNewGoal({ ...newGoal, goalType: opt.key })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <input
                    type="number" inputMode="decimal"
                    placeholder={
                      newGoal.goalType === 'percent' ? 'Target %, e.g. 55'
                        : newGoal.goalType === 'revenuePerUnit' ? 'Target $ per unit, e.g. 15'
                        : 'Target units, e.g. 15'
                    }
                    value={newGoal.target} onChange={e => setNewGoal({ ...newGoal, target: e.target.value })}
                    style={{ ...styles.input, marginBottom: 8 }}
                  />

                  <div style={styles.adminSubLabel}>
                    {newGoal.goalType === 'percent' ? 'Counts as attached'
                      : newGoal.goalType === 'revenuePerUnit' ? 'Revenue source'
                      : 'Counts toward this goal'}
                  </div>
                  {newGoal.goalType === 'revenuePerUnit' && newGoal.categoryNames.includes('Accessories') && (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '-2px 2px 8px', lineHeight: 1.4 }}>
                      Only accessories logged as "Essential accessory" count toward this revenue total.
                    </div>
                  )}
                  {newGoal.categoryNames.includes('Visa') && (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '-2px 2px 8px', lineHeight: 1.4 }}>
                      Only Visa applications logged as "Priority Customer" count here — every Visa still pays commission regardless.
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {Object.keys(VIRTUAL_GOAL_TAGS).map(tag => {
                      const on = newGoal.categoryNames.includes(tag);
                      return (
                        <button
                          key={tag} className="press"
                          style={{ ...(on ? styles.chipOn : styles.chip), borderColor: 'var(--accent)', color: on ? undefined : 'var(--accent)' }}
                          onClick={() => setNewGoal({
                            ...newGoal,
                            categoryNames: on
                              ? newGoal.categoryNames.filter(n => n !== tag)
                              : [...newGoal.categoryNames, tag],
                          })}
                        >
                          {goalTagLabel(tag)}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: newGoal.goalType === 'percent' ? 14 : 12 }}>
                    {categories.filter(c => !HIDDEN_IN_PICKER.includes(c.name)).map(c => {
                      const on = newGoal.categoryNames.includes(c.name);
                      return (
                        <button
                          key={c.name} className="press"
                          style={on ? styles.chipOn : styles.chip}
                          onClick={() => setNewGoal({
                            ...newGoal,
                            categoryNames: on
                              ? newGoal.categoryNames.filter(n => n !== c.name)
                              : [...newGoal.categoryNames, c.name],
                          })}
                        >
                          {c.name}
                        </button>
                      );
                    })}
                  </div>

                  {(newGoal.goalType === 'percent' || newGoal.goalType === 'revenuePerUnit') && (
                    <>
                      <div style={styles.adminSubLabel}>{newGoal.goalType === 'revenuePerUnit' ? 'Per' : 'Out of'}</div>
                      {newGoal.goalType === 'percent' && newGoal.baseCategoryNames.includes('Upgrade') && (
                        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '-4px 2px 8px', lineHeight: 1.4 }}>
                          An Upgrade logged as "Line already has protection" won't count here — it's not a real opportunity.
                        </div>
                      )}
                      {newGoal.goalType === 'percent' && newGoal.baseCategoryNames.includes('Voice Line') && (
                        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '-4px 2px 8px', lineHeight: 1.4 }}>
                          A BYOD Voice Line only counts here if BYOD Protection was attached — Protection 360 isn't an option on BYOD.
                        </div>
                      )}
                      {newGoal.goalType === 'revenuePerUnit' && newGoal.baseCategoryNames.includes('Voice Line') && (
                        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '-4px 2px 8px', lineHeight: 1.4 }}>
                          A BYOD Voice Line only counts here if something in "Revenue source" was actually sold on it — it never counts against you empty.
                        </div>
                      )}
                      {newGoal.goalType === 'percent' &&
                        (newGoal.categoryNames.includes('__premiumPlans__') || newGoal.categoryNames.includes('__essentialPlans__')) &&
                        newGoal.baseCategoryNames.includes('Voice Line') && (
                        <div style={{ fontSize: 11.5, color: '#DC2626', margin: '-4px 2px 8px', lineHeight: 1.4 }}>
                          Voice Line will dilute a plan-tier rate — "Out of" should usually just be Postpaid Rate Plan.
                        </div>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                        {Object.keys(VIRTUAL_GOAL_TAGS).map(tag => {
                          const on = newGoal.baseCategoryNames.includes(tag);
                          return (
                            <button
                              key={tag} className="press"
                              style={{ ...(on ? styles.chipOn : styles.chip), borderColor: 'var(--accent)', color: on ? undefined : 'var(--accent)' }}
                              onClick={() => setNewGoal({
                                ...newGoal,
                                baseCategoryNames: on
                                  ? newGoal.baseCategoryNames.filter(n => n !== tag)
                                  : [...newGoal.baseCategoryNames, tag],
                              })}
                            >
                              {goalTagLabel(tag)}
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                        {categories.filter(c => !HIDDEN_IN_PICKER.includes(c.name)).map(c => {
                          const on = newGoal.baseCategoryNames.includes(c.name);
                          return (
                            <button
                              key={c.name} className="press"
                              style={on ? styles.chipOn : styles.chip}
                              onClick={() => setNewGoal({
                                ...newGoal,
                                baseCategoryNames: on
                                  ? newGoal.baseCategoryNames.filter(n => n !== c.name)
                                  : [...newGoal.baseCategoryNames, c.name],
                              })}
                            >
                              {c.name}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}

                  <button
                    style={{
                      ...styles.secondaryBtn,
                      opacity: newGoal.name.trim() && newGoal.target && newGoal.categoryNames.length &&
                        (newGoal.goalType === 'units' || newGoal.baseCategoryNames.length) ? 1 : 0.5,
                    }}
                    disabled={!newGoal.name.trim() || !newGoal.target || !newGoal.categoryNames.length ||
                      (newGoal.goalType !== 'units' && !newGoal.baseCategoryNames.length)}
                    onClick={async () => {
                      const ok = editingGoalId
                        ? await updateGoal(adminGoalMonth, adminGoalType, editingGoalId, newGoal)
                        : await addGoal(adminGoalMonth, adminGoalType, newGoal);
                      if (ok) {
                        setEditingGoalId(null);
                        setNewGoal({ name: '', target: '', goalType: 'units', categoryNames: [], baseCategoryNames: [] });
                      }
                    }}
                  >
                    {editingGoalId
                      ? <><Check size={16} style={{ marginRight: 6 }} /> Save changes</>
                      : <><TrendingUp size={16} style={{ marginRight: 6 }} /> Add goal</>}
                  </button>
                </div>

                <div style={styles.adminSectionLabel}><Zap size={13} />SPIFFs</div>
                <div style={styles.card}>
                  {spiffs.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)', gap: 8, opacity: s.active ? 1 : 0.5 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--spiff)', fontWeight: 700 }}>
                          +{fmtMoneyPlain(s.amount)} · {s.planName || s.categoryName}
                        </div>
                      </div>
                      <button
                        className="press"
                        style={{ ...styles.chip, ...(s.active ? { borderColor: 'var(--spiff)', color: 'var(--spiff)' } : {}), padding: '5px 10px', fontSize: 11.5 }}
                        onClick={() => toggleSpiff(s.id)}
                      >
                        {s.active ? 'Active' : 'Paused'}
                      </button>
                      <button style={styles.iconBtnSm} onClick={() => removeSpiff(s.id)}><Trash2 size={14} /></button>
                    </div>
                  ))}

                  <div style={styles.adminSubLabel}>Add a SPIFF</div>
                  <input
                    value={newSpiff.label} onChange={e => setNewSpiff({ ...newSpiff, label: e.target.value })} placeholder="Name, e.g. Holiday BYOD Bonus"
                    style={{ ...styles.input, marginBottom: 8 }}
                  />
                  <select
                    value={newSpiff.categoryName}
                    onChange={e => setNewSpiff({ ...newSpiff, categoryName: e.target.value, planName: '' })}
                    style={{ ...styles.input, marginBottom: 8 }}
                  >
                    <option value="">Applies to which category…</option>
                    {categories.filter(c => !HIDDEN_IN_PICKER.includes(c.name)).map(c => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                  {newSpiff.categoryName && plansForCategory(newSpiff.categoryName) && (
                    <select
                      value={newSpiff.planName}
                      onChange={e => setNewSpiff({ ...newSpiff, planName: e.target.value })}
                      style={{ ...styles.input, marginBottom: 8 }}
                    >
                      <option value="">Any plan in this category</option>
                      {plansForCategory(newSpiff.categoryName).map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  )}
                  <input
                    type="number" inputMode="decimal" placeholder="Bonus $ per unit, e.g. 10"
                    value={newSpiff.amount} onChange={e => setNewSpiff({ ...newSpiff, amount: e.target.value })}
                    style={{ ...styles.input, marginBottom: 8 }}
                  />
                  <button
                    style={styles.secondaryBtn}
                    onClick={async () => { if (await addSpiff(newSpiff)) setNewSpiff({ label: '', categoryName: '', planName: '', amount: '' }); }}
                  >
                    <Zap size={16} style={{ marginRight: 6 }} /> Add SPIFF
                  </button>
                </div>

                <div style={styles.adminSectionLabel}><Upload size={13} style={{ transform: 'rotate(180deg)' }} />Publish to Team</div>
                <div style={styles.card}>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 12, lineHeight: 1.5 }}>
                    Pushes the goals and SPIFFs above to every device — no customer or sales data is ever touched.
                    {teamConfigUpdatedAt && ` Last published ${fmtDateNice(teamConfigUpdatedAt.slice(0, 10))}.`}
                  </div>
                  {!SUPABASE_READY && (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 10, lineHeight: 1.4 }}>
                      Not set up yet — add your Supabase URL and key near the top of the code, and run team-config-setup.sql once.
                    </div>
                  )}
                  <input
                    type="password" value={publishPassphrase} onChange={e => setPublishPassphrase(e.target.value)}
                    placeholder="Publish passphrase" style={{ ...styles.input, marginBottom: 8 }}
                  />
                  <button
                    style={{ ...styles.secondaryBtn, opacity: publishBusy || !SUPABASE_READY ? 0.5 : 1 }}
                    disabled={publishBusy || !SUPABASE_READY}
                    onClick={publishGoalsAndSpiffs}
                  >
                    {publishBusy ? 'Publishing\u2026' : 'Publish goals & SPIFFs'}
                  </button>
                  {teamConfigError && (
                    <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 10, lineHeight: 1.5 }}>{teamConfigError}</div>
                  )}
                </div>

              </>
            )}
          </div>
        )}
      </div>

      {(tab === 'dashboard' || tab === 'sales') && (
        <button className="press" style={styles.fab} onClick={() => setShowSaleModal(true)}><Plus size={25} strokeWidth={2.4} /></button>
      )}
      {tab === 'customers' && (
        <button className="press" style={styles.fab} onClick={() => setCustomerModal({ open: true, initial: null, id: null })}><Plus size={25} strokeWidth={2.4} /></button>
      )}

      {/* bottom nav */}
      <div style={styles.nav}>
        <NavBtn icon={Home} label="Home" active={tab === 'dashboard'} onClick={() => setTab('dashboard')} />
        <NavBtn icon={DollarSign} label="Sales" active={tab === 'sales'} onClick={() => setTab('sales')} />
        <NavBtn icon={Users} label="Customers" active={tab === 'customers'} onClick={() => setTab('customers')} />
        <NavBtn icon={Smartphone} label="Plans" active={tab === 'plans'} onClick={() => setTab('plans')} />
        <NavBtn icon={TrendingUp} label="Goals" active={tab === 'goals'} onClick={() => setTab('goals')} />
        <NavBtn icon={SettingsIcon} label="Settings" active={tab === 'settings'} onClick={() => { setTab('settings'); handleRatesTap(); }} />
      </div>

      {toast && <div style={styles.toast}>{toast}</div>}

      <SaleModal
        open={showSaleModal} onClose={() => { setShowSaleModal(false); setSaleModalPlan(null); }} onSave={addCommission}
        categories={categories} initialPlan={saleModalPlan} spiffs={spiffs}
        customers={customers} onCreateCustomer={quickAddCustomer}
      />
      <CustomerModal
        open={customerModal.open}
        onClose={() => setCustomerModal({ open: false, initial: null, id: null })}
        initial={customerModal.initial}
        commissions={commissions}
        onSave={(data) => customerModal.id ? editCustomer(customerModal.id, data) : addCustomer(data)}
        onDelete={customerModal.id ? () => { deleteCustomer(customerModal.id); setCustomerModal({ open: false, initial: null, id: null }); } : null}
      />

    </div>
  );
}

function NavBtn({ icon: Icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={styles.navBtn} className="press">
      <Icon size={20} color={active ? 'var(--accent)' : 'var(--ink-faint)'} strokeWidth={active ? 2.4 : 1.9} />
      <span style={{
        fontSize: 10, fontWeight: active ? 700 : 600,
        color: active ? 'var(--accent)' : 'var(--ink-faint)', marginTop: 3, letterSpacing: '-0.01em',
      }}>
        {label}
      </span>
      <div style={{ ...styles.navDot, opacity: active ? 1 : 0, transition: 'opacity 180ms ease' }} />
    </button>
  );
}

function SaleRow({ sale, customers, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const customer = customers?.find(c => c.id === sale.customerId);

  // Older entries were a single sale; newer ones carry an items array.
  const items = Array.isArray(sale.items) && sale.items.length
    ? sale.items
    : [{ id: 'legacy', category: sale.category, amount: sale.amount, baseValue: sale.baseValue, qty: sale.qty, planName: sale.planName }];
  const multi = items.length > 1;

  function itemDetail(it) {
    const qty = Number(it.qty) || 1;
    const parts = [];
    if (it.planName) parts.push(it.planName);
    if (qty > 1) parts.push(`Qty ${qty}`);
    if (it.alreadyProtected) parts.push('Already protected');
    if (it.isBYOD) parts.push('BYOD');
    if (it.isEssential) parts.push('Essential');
    if (it.isPriority) parts.push('Priority');
    if (it.spiffAmount > 0) parts.push(`+${fmtMoneyPlain(it.spiffAmount)} SPIFF`);
    return parts.join(' \u00b7 ');
  }

  const title = multi ? `${items.length} items` : items[0].category;
  const soloDetail = multi ? '' : itemDetail(items[0]);

  return (
    <div style={styles.saleRow} className="lift">
      <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: 'var(--accent)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ cursor: multi ? 'pointer' : 'default' }}
          onClick={() => multi && setExpanded(v => !v)}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
              {title}
              {multi && (
                <ChevronDown
                  size={13} color="var(--ink-faint)"
                  style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 180ms ease' }}
                />
              )}
            </span>
            <span className="font-display tabular" style={{ fontWeight: 800, fontSize: 14, color: 'var(--positive)' }}>{fmtMoney(sale.amount)}</span>
          </div>
          <div style={{ fontSize: 12, color: customer ? 'var(--ink)' : 'var(--ink-soft)', marginTop: 1, fontWeight: customer ? 600 : 400 }}>
            {fmtDateNice(sale.date)}{customer ? ` · ${customer.name}` : ''}
          </div>
          {soloDetail && <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 1 }}>{soloDetail}</div>}
          {multi && !expanded && (
            <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {items.map(i => i.category).join(' · ')}
            </div>
          )}
        </div>

        {multi && expanded && (
          <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--border)' }}>
            {items.map((it, i) => {
              const Icon = categoryIcon(it.category);
              const d = itemDetail(it);
              return (
                <div key={it.id || i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0' }}>
                  <Icon size={14} strokeWidth={2.1} color="var(--accent)" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{it.category}</div>
                    {d && <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>{d}</div>}
                  </div>
                  <div className="font-display tabular" style={{ fontSize: 12.5, fontWeight: 700 }}>{fmtMoney(it.amount)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {onDelete && (
        <button onClick={onDelete} style={styles.iconBtnSm}><Trash2 size={13} /></button>
      )}
    </div>
  );
}

/* ---------------------------------- styles ---------------------------------- */

// Subtle dark texture applied behind the app's own surfaces — a soft
// vignette with fine grain, dark enough to stay out of the way of text
// and cards, just enough to keep flat black from looking completely flat.
const BG_TEXTURE = 'data:image/jpeg;base64,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';

const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Urbanist:wght@400;500;600;700;800;900&display=swap');

/* ------------------------------------------------------------------------
 * TELENEO — T-Mobile's proprietary typeface. It isn't on any public font
 * CDN, so it can't be auto-loaded — these @font-face rules point at files
 * you add yourself once deployed outside Claude (see DEPLOY.md / the note
 * left for you). Until those files exist, the browser silently falls back
 * to Urbanist below — a free geometric sans chosen to be the closest visual
 * match available, so nothing breaks or looks off in the meantime.
 *
 * To activate: place the real Teleneo files in your project's /public/fonts
 * folder, named to match the src paths below (adjust names/weights to
 * whatever files you actually have — Teleneo may not ship every weight
 * listed here).
 * ------------------------------------------------------------------------ */
@font-face {
  font-family: 'Teleneo';
  src: url('/fonts/Teleneo-Regular.woff2') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Teleneo';
  src: url('/fonts/Teleneo-Medium.woff2') format('woff2');
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Teleneo';
  src: url('/fonts/Teleneo-SemiBold.woff2') format('woff2');
  font-weight: 600; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Teleneo';
  src: url('/fonts/Teleneo-Bold.woff2') format('woff2');
  font-weight: 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Teleneo';
  src: url('/fonts/Teleneo-ExtraBold.woff2') format('woff2');
  font-weight: 800; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Teleneo';
  src: url('/fonts/Teleneo-Black.woff2') format('woff2');
  font-weight: 900; font-style: normal; font-display: swap;
}

:root {
  --bg: #F2F2F6;
  --surface: #FFFFFF;
  --carbon: #0D0D12;
  --carbon-2: #22222E;
  --ink: #0F0F14;
  --ink-soft: #64646F;
  --ink-faint: #9C9CAA;
  --accent: #E20074;
  --accent-2: #FF2D9E;
  --accent-deep: #96004D;
  --accent-soft: #FDE9F3;
  --positive: #00A878;
  --positive-soft: rgba(0,168,120,0.12);
  --positive-ink: #05614A;
  --spiff: #C77700;
  --spiff-soft: rgba(255,179,0,0.14);
  --spiff-border: rgba(255,179,0,0.35);
  --border: #E7E7EE;
  --track: rgba(15,15,20,0.045);
  --neutral-soft: rgba(15,15,20,0.06);
  --nav-bg: rgba(255,255,255,0.92);
  --solid-btn-bg: #0D0D12;
  --solid-btn-fg: #FFFFFF;
  --shadow-sm: 0 1px 2px rgba(15,15,20,0.05);
  --shadow-md: 0 4px 14px rgba(15,15,20,0.07);
  --shadow-glow: 0 10px 30px rgba(226,0,116,0.28);
  color-scheme: light;
}

.theme-dark {
  --bg: #0B0B10;
  --surface: #16161D;
  --carbon: #05050A;
  --carbon-2: #1E1E2A;
  --ink: #F2F2F6;
  --ink-soft: #A2A2B2;
  --ink-faint: #6E6E7E;
  --accent: #FF2D9E;
  --accent-2: #FF6BBA;
  --accent-deep: #C4006A;
  --accent-soft: rgba(255,45,158,0.16);
  --positive: #2BD3A0;
  --positive-soft: rgba(43,211,160,0.16);
  --positive-ink: #7FE9C7;
  --spiff: #FFC94D;
  --spiff-soft: rgba(255,201,77,0.16);
  --spiff-border: rgba(255,201,77,0.4);
  --border: #2A2A36;
  --track: rgba(255,255,255,0.07);
  --neutral-soft: rgba(255,255,255,0.08);
  --nav-bg: rgba(18,18,24,0.92);
  --solid-btn-bg: #2A2A36;
  --solid-btn-fg: #F2F2F6;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.5);
  --shadow-md: 0 4px 14px rgba(0,0,0,0.55);
  --shadow-glow: 0 10px 30px rgba(255,45,158,0.28);
  color-scheme: dark;
}

.theme-dark input,
.theme-dark select,
.theme-dark textarea { color-scheme: dark; }
.font-display { font-family: 'Teleneo', 'Urbanist', system-ui, sans-serif; letter-spacing: -0.02em; }
.font-body { font-family: 'Teleneo', 'Urbanist', system-ui, sans-serif; }
.tabular { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; }
* { box-sizing: border-box; font-family: 'Teleneo', 'Urbanist', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
input, select, textarea, button { font-family: 'Teleneo', 'Urbanist', system-ui, sans-serif; }
button { color: inherit; -webkit-appearance: none; appearance: none; -webkit-tap-highlight-color: transparent; }
* { -ms-overflow-style: none; scrollbar-width: none; }
::-webkit-scrollbar { width: 0px; height: 0px; }

/* iOS Safari's 100vh is based on the toolbar being fully collapsed, so when
   it's showing, the app still thinks it has that space — pushing the bottom
   nav partly under the browser's own UI. 100dvh tracks the real visible
   height instead; the plain vh line above it is just the fallback for any
   engine that doesn't understand dvh yet. */
.app-shell {
  height: 100vh !important;
  height: 100dvh !important;
}

/* Dark mode only — a light theme sitting on a black photographic texture
   would look muddy, so this stays scoped to .theme-dark. The gradient on
   top keeps it dark enough that text and cards never lose contrast. */
.app-shell.theme-dark {
  background-image: linear-gradient(180deg, rgba(11,11,16,0.45) 0%, rgba(11,11,16,0.82) 100%), url(${BG_TEXTURE}) !important;
  background-size: cover !important;
  background-position: center top !important;
  background-repeat: no-repeat !important;
}

/* On phones the app fills the screen edge-to-edge, same as always. On any
   screen wider than that, frame it like a real app window instead of letting
   it float as a thin strip in empty space. */
@media (min-width: 540px) {
  .app-shell {
    margin: 24px auto !important;
    height: calc(100vh - 48px) !important;
    height: calc(100dvh - 48px) !important;
    max-height: 900px;
    border-radius: 28px !important;
    box-shadow: 0 24px 70px rgba(0,0,0,0.28), 0 0 0 1px var(--border);
    overflow: hidden;
  }
}

@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes riseIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes glowDrift {
  0%   { transform: translate(-8%, -12%) scale(1); }
  50%  { transform: translate(10%, 8%) scale(1.15); }
  100% { transform: translate(-8%, -12%) scale(1); }
}
@keyframes barGrow { from { transform: scaleY(0.15); } to { transform: scaleY(1); } }
@keyframes sheen {
  from { transform: translateX(-120%) skewX(-18deg); }
  to   { transform: translateX(320%) skewX(-18deg); }
}

.rise { animation: riseIn 380ms cubic-bezier(.22,.9,.3,1) both; }
.press { transition: transform 120ms ease, box-shadow 160ms ease, border-color 160ms ease; }
.press:active { transform: scale(0.975); }
.lift { transition: transform 160ms ease, box-shadow 200ms ease; }
.lift:active { transform: scale(0.99); box-shadow: var(--shadow-sm); }
.bar { transform-origin: bottom; animation: barGrow 520ms cubic-bezier(.22,.9,.3,1) both; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

const styles = {
  app: {
    display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 480, margin: '0 auto',
    background: 'var(--bg)', color: 'var(--ink)', position: 'relative', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 18px 12px', flexShrink: 0, gap: 12,
  },
  main: { flex: 1, overflowY: 'auto', padding: '4px 16px 96px', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' },

  pillRow: { display: 'flex', gap: 5, marginBottom: 14, background: 'var(--track)', padding: 4, borderRadius: 13 },
  monthStepper: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 13,
    padding: '6px 6px', boxShadow: 'var(--shadow-sm)',
  },
  monthStepperBtn: {
    width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', flexShrink: 0, userSelect: 'none',
  },
  pill: {
    flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', background: 'transparent',
    color: 'var(--ink-soft)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    transition: 'background 180ms ease, color 180ms ease',
  },
  pillActive: {
    flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', background: 'var(--surface)',
    color: 'var(--ink)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
    transition: 'background 180ms ease, color 180ms ease',
  },
  pillSm: {
    padding: '6px 13px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--ink-soft)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
    transition: 'all 160ms ease',
  },
  pillActiveSm: {
    padding: '6px 13px', borderRadius: 999, border: '1px solid var(--accent)', background: 'var(--accent)',
    color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
    transition: 'all 160ms ease',
  },

  heroCard: {
    position: 'relative', overflow: 'hidden',
    background: 'linear-gradient(150deg, var(--carbon-2) 0%, var(--carbon) 62%)',
    color: '#fff', borderRadius: 22, padding: '18px 20px 20px', marginBottom: 10,
    boxShadow: '0 12px 30px rgba(13,13,18,0.22)',
  },
  heroGlow: {
    position: 'absolute', top: '-40%', right: '-25%', width: '85%', height: '190%',
    background: 'radial-gradient(circle, rgba(226,0,116,0.85) 0%, rgba(226,0,116,0.18) 45%, transparent 70%)',
    filter: 'blur(6px)', animation: 'glowDrift 14s ease-in-out infinite', pointerEvents: 'none',
  },

  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 },
  statCard: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 15, padding: '11px 12px',
    textAlign: 'left', cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
  },
  card: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, padding: 15,
    marginBottom: 4, boxShadow: 'var(--shadow-sm)',
  },

  pdfScroll: {
    flex: 1, minHeight: 380, overflow: 'auto', background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 16, padding: 10, WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain',
  },
  pdfPreviewFrame: {
    position: 'relative', height: 260, overflow: 'hidden', background: 'var(--bg)',
    border: '1px solid var(--border)', borderRadius: 16, padding: '10px 10px 0',
  },
  pdfPreviewFade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 92,
    background: 'linear-gradient(180deg, transparent 0%, var(--bg) 88%)',
  },
  pdfPreviewHint: {
    position: 'absolute', left: 12, right: 12, bottom: 10, display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: '9px 12px', borderRadius: 999,
    background: 'var(--solid-btn-bg)', color: 'var(--solid-btn-fg)', fontSize: 12, fontWeight: 700,
    boxShadow: '0 6px 16px rgba(13,13,18,0.28)',
  },
  zoomBar: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  zoomBtn: {
    width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--ink)', fontSize: 17, fontWeight: 700, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', lineHeight: 1, flexShrink: 0, boxShadow: 'var(--shadow-sm)',
  },

  ticker: {
    position: 'relative', overflow: 'hidden',
    background: 'linear-gradient(150deg, var(--carbon-2) 0%, var(--carbon) 65%)',
    color: '#fff', borderRadius: 18, padding: '14px 16px', marginBottom: 4,
    boxShadow: '0 8px 22px rgba(13,13,18,0.2)', transition: 'opacity 220ms ease',
  },
  tickerGlow: {
    position: 'absolute', top: '-60%', right: '-20%', width: '70%', height: '220%',
    background: 'radial-gradient(circle, rgba(226,0,116,0.8) 0%, rgba(226,0,116,0.15) 48%, transparent 72%)',
    filter: 'blur(6px)', animation: 'glowDrift 14s ease-in-out infinite', pointerEvents: 'none',
  },
  linkCustomerBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%',
    padding: '10px 0', borderRadius: 12, border: '1px dashed var(--border)', background: 'transparent',
    color: 'var(--ink-soft)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  linkedCustomerRow: {
    display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', borderRadius: 13,
    background: 'var(--accent-soft)', border: '1px solid rgba(226,0,116,0.22)',
  },
  lineItem: {
    display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 13, padding: '10px 11px', marginBottom: 7,
    boxShadow: 'var(--shadow-sm)',
  },
  lineItemIcon: {
    width: 30, height: 30, borderRadius: 9, background: 'var(--accent-soft)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  planTrigger: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 13,
    padding: '12px 14px', cursor: 'pointer', boxShadow: 'var(--shadow-sm)', color: 'var(--ink)',
  },
  adminSectionLabel: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, fontWeight: 800, letterSpacing: '0.03em', color: 'var(--ink-soft)',
    margin: '20px 2px 8px',
  },
  adminSubLabel: {
    fontSize: 11.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
    color: 'var(--ink-faint)', margin: '14px 0 8px',
  },
  planGroupLabel: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--accent)', margin: '0 2px 9px',
  },
  planGroupDot: {
    width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0,
  },
  sectionDivider: {
    height: 2, borderRadius: 2, marginBottom: 16,
    background: 'linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)',
    opacity: 0.35,
  },
  planOption: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 13,
    padding: '11px 13px', marginBottom: 7, cursor: 'pointer', color: 'var(--ink)',
    boxShadow: 'var(--shadow-sm)',
  },
  planOptionOn: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
    background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 13,
    padding: '11px 13px', marginBottom: 7, cursor: 'pointer', color: 'var(--ink)',
    boxShadow: 'var(--shadow-sm)',
  },
  planOptionName: {
    flex: 1, minWidth: 0, textAlign: 'left', fontSize: 13.5, fontWeight: 700,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  planPickerNote: {
    fontSize: 11.5, color: 'var(--ink-faint)', margin: '-4px 2px 14px', lineHeight: 1.4,
  },
  planCheck: {
    width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  checkboxRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
    fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)', cursor: 'pointer',
  },
  checkboxRowWarn: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
    fontSize: 13, fontWeight: 700, color: 'var(--solid-btn-fg)', cursor: 'pointer',
    background: 'var(--solid-btn-bg)', border: 'none',
    borderRadius: 11, padding: '9px 11px', accentColor: 'var(--accent)',
  },
  spiffCallout: {
    display: 'flex', alignItems: 'center', gap: 7, marginTop: 12,
    background: 'var(--positive-soft)', border: '1px solid rgba(0,168,120,0.28)', color: 'var(--positive-ink)',
    borderRadius: 11, padding: '9px 11px', fontSize: 11.5, fontWeight: 700, lineHeight: 1.45,
  },
  spiffBadge: {
    fontSize: 10, fontWeight: 800, letterSpacing: 0.2, padding: '2px 7px', borderRadius: 999,
    background: 'var(--spiff-soft)', color: 'var(--spiff)', whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', gap: 3,
  },
  qtyBadge: {
    fontSize: 10, fontWeight: 800, letterSpacing: 0.2, padding: '2px 7px', borderRadius: 999,
    background: 'var(--accent-soft)', color: 'var(--accent)', whiteSpace: 'nowrap',
  },
  qtyRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 },
  qtyBtn: {
    width: 26, height: 26, borderRadius: 8, border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--ink)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0,
  },
  draftPanel: {
    marginTop: 10, padding: 14, borderRadius: 16,
    background: 'var(--bg)', border: '1px solid var(--border)',
  },
  addItemBtn: {
    width: '100%', marginTop: 14, padding: '11px 0', borderRadius: 12, border: 'none',
    background: 'var(--solid-btn-bg)', color: 'var(--solid-btn-fg)', fontWeight: 700, fontSize: 13.5,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  chip: {
    padding: '9px 14px', borderRadius: 11, border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--ink-soft)', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    boxShadow: 'var(--shadow-sm)', transition: 'all 150ms ease',
  },
  chipOn: {
    padding: '9px 14px', borderRadius: 11, border: '1px solid var(--accent)', background: 'var(--accent)',
    color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
    boxShadow: '0 4px 12px rgba(226,0,116,0.28)', transition: 'all 150ms ease',
  },
  catGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
  },
  catTile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 74, padding: '10px 6px', borderRadius: 15, cursor: 'pointer',
    border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--ink)',
    boxShadow: 'var(--shadow-sm)', transition: 'all 150ms ease',
  },
  catTileOn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 74, padding: '10px 6px', borderRadius: 15, cursor: 'pointer',
    border: '1px solid var(--accent)', color: '#fff',
    background: 'linear-gradient(140deg, var(--accent-2) 0%, var(--accent) 60%, var(--accent-deep) 100%)',
    boxShadow: '0 6px 16px rgba(226,0,116,0.32)', transition: 'all 150ms ease',
  },

  saleRow: {
    display: 'flex', gap: 11, background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 15, padding: '11px 13px', marginBottom: 8, alignItems: 'stretch', boxShadow: 'var(--shadow-sm)',
  },
  customerRow: {
    display: 'flex', alignItems: 'center', gap: 11, background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 15, padding: '11px 13px', marginBottom: 8, cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
  },
  planCard: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '13px 15px',
    marginBottom: 8, boxShadow: 'var(--shadow-sm)',
  },
  planBadge: {
    display: 'inline-flex', alignItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent)',
    fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
  },
  goalTrack: {
    height: 8, borderRadius: 999, background: 'var(--track)', overflow: 'hidden',
  },
  goalFill: {
    height: '100%', borderRadius: 999, transition: 'width 400ms ease',
  },
  promoBadge: {
    display: 'inline-flex', alignItems: 'center', background: 'var(--positive-soft)', color: 'var(--positive)',
    fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
  },
  promoCallout: {
    background: 'var(--positive-soft)', border: '1px solid rgba(0,168,120,0.28)', color: 'var(--positive-ink)',
    borderRadius: 12, padding: '11px 13px', marginBottom: 12,
  },
  tierChip: {
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 9, padding: '6px 10px', fontSize: 12,
  },
  tierChipPromo: {
    background: 'var(--positive-soft)', border: '1px solid rgba(0,168,120,0.28)', borderRadius: 9,
    padding: '6px 10px', fontSize: 12,
  },

  input: {
    width: '100%', padding: '11px 13px', borderRadius: 12, border: '1px solid var(--border)',
    fontSize: 14.5, background: 'var(--surface)', color: 'var(--ink)', outline: 'none',
    transition: 'border-color 160ms ease, box-shadow 160ms ease',
  },
  primaryBtn: {
    width: '100%', padding: '13px 0', borderRadius: 14, border: 'none',
    background: 'linear-gradient(120deg, var(--accent) 0%, var(--accent-deep) 100%)',
    color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer', marginTop: 4,
    boxShadow: 'var(--shadow-glow)', letterSpacing: '-0.01em',
  },
  secondaryBtn: {
    padding: '10px 15px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--ink)', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)',
    transition: 'transform 120ms ease',
  },
  linkBtn: {
    border: 'none', background: 'none', color: 'var(--accent)', fontWeight: 700, fontSize: 12.5,
    display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer', padding: 0,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 13, border: '1px solid var(--border)', background: 'var(--surface)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    flexShrink: 0, boxShadow: 'var(--shadow-sm)', color: 'var(--ink)',
  },
  iconBtnSm: {
    width: 30, height: 30, borderRadius: 10, border: 'none', background: 'var(--bg)', color: 'var(--ink-soft)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
  },

  fab: {
    position: 'absolute', right: 18, bottom: 88, width: 56, height: 56, borderRadius: 19,
    background: 'linear-gradient(135deg, var(--accent-2) 0%, var(--accent) 55%, var(--accent-deep) 100%)',
    color: '#fff', border: 'none', display: 'flex', alignItems: 'center',
    justifyContent: 'center', boxShadow: '0 10px 26px rgba(226,0,116,0.42)', cursor: 'pointer', zIndex: 5,
  },

  nav: {
    display: 'flex', borderTop: '1px solid var(--border)', background: 'var(--nav-bg)',
    backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
    padding: '7px 8px calc(7px + env(safe-area-inset-bottom))', flexShrink: 0,
  },
  navBtn: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', border: 'none',
    background: 'none', cursor: 'pointer', padding: '5px 0 3px', position: 'relative',
  },
  navDot: {
    width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)', marginTop: 3,
  },

  sheetOverlay: {
    position: 'absolute', inset: 0, background: 'rgba(13,13,18,0.5)', display: 'flex',
    alignItems: 'flex-end', zIndex: 20, backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
  },
  sheet: {
    width: '100%', maxHeight: '88vh', background: 'var(--surface)', borderRadius: '24px 24px 0 0',
    padding: '10px 18px 22px', boxShadow: '0 -8px 40px rgba(13,13,18,0.22)',
  },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 14px' },

  livePulse: { width: 7, height: 7, borderRadius: '50%', background: 'var(--positive)', display: 'inline-block', animation: 'pulse 1.8s ease-in-out infinite' },
  toast: {
    position: 'absolute', bottom: 96, left: '50%', transform: 'translateX(-50%)', background: 'var(--carbon)',
    color: '#fff', padding: '10px 18px', borderRadius: 999, fontSize: 13, fontWeight: 600, zIndex: 30,
    boxShadow: '0 8px 24px rgba(13,13,18,0.3)', whiteSpace: 'nowrap',
  },
  deleteLink: {
    display: 'block', width: '100%', textAlign: 'center', marginTop: 10, padding: '9px 0',
    background: 'none', border: 'none', color: '#DC2626', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
};
