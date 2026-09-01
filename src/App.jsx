import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Home, DollarSign, Users, Settings as SettingsIcon, Plus, X,
  Search, Phone, Mail, Edit2, Trash2, TrendingUp, LogOut,
  ChevronRight, ChevronLeft, ChevronDown, Smartphone, ShieldCheck, Upload, ExternalLink, FileText,
  Wifi, Watch, Tablet, CreditCard, Package, Zap, Gift, Check, Minus, ArrowUpCircle, UserPlus, Maximize2, Shield
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
  AreaChart, Area
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
// Passcode gating the hidden developer settings. Changeable in-app once
// unlocked; this is only the fallback for a device that hasn't set one.
const DEFAULT_DEV_PIN = '070920';

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
function unitsSoldForGoal(commissions, categoryNames, monthKey, opts) {
  const names = categoryNames || [];
  const plainSet = new Set(names.filter(n => !VIRTUAL_GOAL_TAGS[n]));
  const virtualMatchers = names.filter(n => VIRTUAL_GOAL_TAGS[n]).map(n => VIRTUAL_GOAL_TAGS[n].match);
  const excludeNoOpportunity = opts && opts.excludeNoOpportunity;
  let total = 0;
  for (const c of commissions) {
    if ((c.date || '').slice(0, 7) !== monthKey) continue;
    const items = itemsOf(c);
    for (const it of items) {
      if (it.category === 'Visa' && !it.isPriority) continue; // every Visa gets paid, but only priority customers count toward the goal
      if (excludeNoOpportunity) {
        if (it.alreadyProtected) continue; // upgrade — line already protected, not an opportunity
        // A BYOD line is never an attach opportunity: it can't take Protection
        // 360 and brings no new device. BYOD Protection still counts on the
        // "attached" side, so selling one lifts the rate without adding to the
        // denominator — a few of them can carry the whole percentage.
        if (it.category === 'Voice Line' && it.isBYOD) continue;
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
    const opts = { excludeNoOpportunity: true };
    const numerator = unitsSoldForGoal(commissions, goalCategoryNames(g), monthKey, opts);
    const denominator = unitsSoldForGoal(commissions, g.baseCategoryNames || [], monthKey, opts);
    const achieved = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
    const pct = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;
    const met = target > 0 && denominator > 0 && achieved >= target;
    return { achieved, target, pct, met, isPercent: true, numerator, denominator };
  }
  if (g.goalType === 'revenuePerUnit') {
    const revenue = revenueForGoal(commissions, goalCategoryNames(g), monthKey);
    const opts = { excludeNoOpportunity: true };
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

// Feature revenue paid per line on top of the rate plan commission. Only the
// two premium families carry it — Essentials and Essentials Saver pay none.
const FEATURE_REVENUE_PER_LINE = { Beyond: 15, More: 10 };
function featureRevenueFor(planName, lines) {
  const rate = FEATURE_REVENUE_PER_LINE[planFamilyOf(planName)] || 0;
  return rate * (Number(lines) || 1);
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
  '__btsPrepaid__': {
    label: 'Prepaid flagged as BTS',
    match: it => it.category === 'Prepaid Plan' && !!it.isBTS,
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

// Category flags (BYOD, Essential, BTS, etc). Filled magenta when on, quiet
// outline when off — so the state is obvious at a glance rather than needing
// you to look at a small checkbox.
function FlagToggle({ checked, onChange, children }) {
  return (
    <label style={checked ? styles.flagToggleOn : styles.flagToggleOff} className="press">
      <input type="checkbox" checked={checked} onChange={onChange} style={{ display: 'none' }} />
      <span style={checked ? styles.flagMarkOn : styles.flagMarkOff}>
        {checked && <Check size={12} strokeWidth={3.2} color="#fff" />}
      </span>
      {children}
    </label>
  );
}

function MonthStepper({ value, onChange, label }) {
  const holdTimer = React.useRef(null);
  const holdInterval = React.useRef(null);

  function step(delta) { onChange(shiftMonth(value, delta)); }

  function startHold(delta) {
    step(delta);
    holdTimer.current = setTimeout(() => {
      holdInterval.current = setInterval(() => step(delta), 420);
    }, 500);
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

function SaleModal({ open, onClose, onSave, categories, initialPlan, spiffs, customers, onCreateCustomer, onEditCustomer }) {
  const emptyDraft = { category: '', baseValue: '', qty: '1', manualAmount: '', planName: '', lines: '1', alreadyProtected: false, isBYOD: false, isEssential: false, isPriority: false, isBTS: false };
  const emptyForm = { date: todayInputValue(), notes: '', items: [], customerId: '' };
  const [form, setForm] = useState(emptyForm);
  const [draft, setDraft] = useState(emptyDraft);
  const [quickAddName, setQuickAddName] = useState('');
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [hiPickerOpen, setHiPickerOpen] = useState(false);
  const [fiberPickerOpen, setFiberPickerOpen] = useState(false);
  const [watchPickerOpen, setWatchPickerOpen] = useState(false);
  const [tabletPickerOpen, setTabletPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm);
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
  const draftBaseCommission = computeCommission(draftCat, draft);
  // Beyond/More pay feature revenue per line on top of the rate plan commission.
  const draftFeatureRevenue = isPlanCategory ? featureRevenueFor(draft.planName, draft.lines) : 0;
  const draftAmount = draftBaseCommission + draftFeatureRevenue;
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
    if (isPlanCategory) {
      item.lines = Number(draft.lines) || 1;
      if (draftFeatureRevenue > 0) item.featureRevenue = Math.round(draftFeatureRevenue * 100) / 100;
    }
    if (draft.category === 'Upgrade' && draft.alreadyProtected) item.alreadyProtected = true;
    if (draft.category === 'Voice Line' && draft.isBYOD) item.isBYOD = true;
    if (draft.category === 'Accessories' && draft.isEssential) item.isEssential = true;
    if (draft.category === 'Visa' && draft.isPriority) item.isPriority = true;
    if (draft.category === 'Prepaid Plan' && draft.isBTS) item.isBTS = true;
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
        }) + (Number(it.featureRevenue) || 0); // feature revenue is per-line, not per-qty
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
      setQuickAddName('');
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
          style={{ ...styles.input, flex: 1 }}
        />
      </div>

      {/* customer — name field is ready to type in as soon as the sheet opens */}
      {(() => {
        const linkedCustomer = customers?.find(x => x.id === form.customerId);
        if (linkedCustomer) {
          return (
            <div
              style={{ ...styles.linkedCustomerRow, marginTop: 14, cursor: 'pointer' }}
              className="press"
              onClick={() => onEditCustomer && onEditCustomer(linkedCustomer)}
            >
              <Avatar name={linkedCustomer.name} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {linkedCustomer.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
                  {linkedCustomer.phone || linkedCustomer.email || 'Tap to add details'}
                </div>
              </div>
              <button
                style={styles.iconBtnSm}
                onClick={(e) => { e.stopPropagation(); setForm({ ...form, customerId: '' }); }}
              >
                <X size={13} />
              </button>
            </div>
          );
        }
        return (
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 14 }}>
            <input
              value={quickAddName} onChange={e => setQuickAddName(e.target.value)} placeholder="Customer Name"
              style={{ ...styles.input, flex: 1, padding: '9px 11px', fontSize: 13 }}
              onKeyDown={e => e.key === 'Enter' && submitQuickAdd()}
            />
            <button
              className="press"
              style={{ ...styles.addCustomerBtn, opacity: quickAddName.trim() ? 1 : 0.5 }}
              disabled={!quickAddName.trim()} onClick={submitQuickAdd} aria-label="Add this customer"
            >
              <UserPlus size={16} strokeWidth={2.2} />
            </button>
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
                <div className="font-display tabular" style={{ fontSize: 14, fontWeight: 800, color: 'var(--money)' }}>{fmtMoney(it.amount)}</div>
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

          {draft.category === 'Upgrade' && (
            <FlagToggle
              checked={draft.alreadyProtected}
              onChange={e => setDraft({ ...draft, alreadyProtected: e.target.checked })}
            >
              Line already has protection
            </FlagToggle>
          )}

          {draft.category === 'Accessories' && (
            <FlagToggle
              checked={draft.isEssential}
              onChange={e => setDraft({ ...draft, isEssential: e.target.checked })}
            >
              Essential Accessories
            </FlagToggle>
          )}

          {draft.category === 'Visa' && (
            <FlagToggle
              checked={draft.isPriority}
              onChange={e => setDraft({ ...draft, isPriority: e.target.checked })}
            >
              Priority Customer
            </FlagToggle>
          )}

          {draft.category === 'Prepaid Plan' && (
            <FlagToggle
              checked={draft.isBTS}
              onChange={e => setDraft({ ...draft, isBTS: e.target.checked })}
            >
              Counts as BTS
            </FlagToggle>
          )}

          {draft.category === 'Voice Line' && (
            <FlagToggle
              checked={draft.isBYOD}
              onChange={e => setDraft({ ...draft, isBYOD: e.target.checked })}
            >
              Bring your own device (BYOD)
            </FlagToggle>
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
    <Sheet elevated open={open} onClose={onClose} title={initial ? 'Edit customer' : 'Add customer'}>
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
              <div className="font-display tabular" style={{ fontSize: 13, fontWeight: 800, color: 'var(--money)' }}>{fmtMoney(historyTotal)}</div>
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
  const [chartPage, setChartPage] = useState(0);
  const chartScrollRef = React.useRef(null);
  const [saleMonth, setSaleMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [saleDay, setSaleDay] = useState(''); // '' = whole month
  const [goalMonth, setGoalMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [customerSearch, setCustomerSearch] = useState('');
  const [showSaleModal, setShowSaleModal] = useState(false);
  const [saleModalPlan, setSaleModalPlan] = useState(null);
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [salesSubTab, setSalesSubTab] = useState('sales'); // 'sales' | 'customers'
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
  const [pinPadOpen, setPinPadOpen] = useState(false);
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState('');
  const [devPin, setDevPin] = useState(DEFAULT_DEV_PIN);
  const [newPin, setNewPin] = useState('');
  const rateTapCountRef = React.useRef(0);
  const rateTapTimerRef = React.useRef(null);
  const RATE_TAP_TARGET = 5;

  function handleRatesTap() {
    if (showRates) return; // already unlocked this session
    rateTapCountRef.current += 1;
    if (rateTapTimerRef.current) clearTimeout(rateTapTimerRef.current);
    rateTapTimerRef.current = setTimeout(() => { rateTapCountRef.current = 0; }, 1200);
    if (rateTapCountRef.current >= RATE_TAP_TARGET) {
      rateTapCountRef.current = 0;
      setPinEntry('');
      setPinError('');
      setPinPadOpen(true);
    }
  }

  function pressPin(digit) {
    setPinError('');
    const next = (pinEntry + digit).slice(0, 6);
    setPinEntry(next);
    if (next.length === 6) {
      // Small delay so the last dot visibly fills before the pad reacts.
      setTimeout(() => {
        if (next === devPin) {
          setPinPadOpen(false);
          setPinEntry('');
          setShowRates(true);
        } else {
          setPinError('Incorrect passcode');
          setPinEntry('');
        }
      }, 140);
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
    const bg = isDark ? '#0B0B10' : '#E6E6EE';
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

    const dp = await safeGet('devPin', false);
    if (dp) { try { const v = JSON.parse(dp.value); if (/^\d{6}$/.test(v)) setDevPin(v); } catch (e) {} }

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

  // Cumulative earnings across the current month, with a straight-line pace
  // reference so it's clear whether you're running ahead of or behind an even
  // daily split. Days after today are left null so the line stops at today
  // rather than flattening out to the right edge.
  const monthTrend = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = now.getDate();

    const byDay = new Array(daysInMonth + 1).fill(0);
    commissions.forEach(c => {
      if (c.repName !== myName) return;
      const d = new Date(c.date);
      if (d.getFullYear() !== year || d.getMonth() !== month) return;
      byDay[d.getDate()] += Number(c.amount || 0);
    });

    let running = 0;
    const rows = [];
    for (let day = 1; day <= daysInMonth; day++) {
      if (day <= today) running += byDay[day];
      rows.push({
        day,
        label: String(day),
        earned: day <= today ? Math.round(running * 100) / 100 : null,
      });
    }

    const mtd = running;
    const perDay = today > 0 ? mtd / today : 0;
    const projected = Math.round(perDay * daysInMonth * 100) / 100;

    return { rows, mtd: Math.round(mtd * 100) / 100, projected, today, daysInMonth };
  }, [commissions, myName]);

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
  // When a specific day is picked, narrow to just that date.
  const shownSales = useMemo(
    () => (saleDay ? monthSales.filter(s => (s.date || '').slice(0, 10) === saleDay) : monthSales),
    [monthSales, saleDay]
  );
  const shownTotal = useMemo(() => shownSales.reduce((s, c) => s + Number(c.amount || 0), 0), [shownSales]);

  // Last day of the shown month, so the day picker can't wander outside it.
  const monthDayBounds = useMemo(() => {
    const [y, m] = saleMonth.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { min: `${saleMonth}-01`, max: `${saleMonth}-${String(last).padStart(2, '0')}` };
  }, [saleMonth]);

  function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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
                <div className="font-display tabular" style={{ fontSize: 46, fontWeight: 800, margin: '8px 0 2px', letterSpacing: '0.03em', lineHeight: 1.05 }}>
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
                  <div className="font-display tabular" style={{ fontSize: 16.5, fontWeight: 800, marginTop: 3, color: 'var(--money)' }}>{fmtMoney(myTotals[p])}</div>
                </button>
              ))}
            </div>

            {/* charts carousel — swipe between the two views */}
            <div
              ref={chartScrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                const page = Math.round(el.scrollLeft / el.clientWidth);
                if (page !== chartPage) setChartPage(page);
              }}
              style={styles.chartCarousel}
            >
              <div style={styles.chartSlide}>
                <div style={{ ...styles.card, height: '100%' }} className="rise">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                    <TrendingUp size={15} color="var(--accent)" />
                    <div className="font-display" style={{ fontWeight: 800, fontSize: 13.5 }}>Last 7 days</div>
                  </div>
                  <div style={{ height: 130 }}>
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
                        <Bar dataKey="total" fill="url(#barGrad)" radius={[6, 6, 0, 0]} animationDuration={620} isAnimationActive={true} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              <div style={styles.chartSlide}>
                <div style={{ ...styles.card, height: '100%' }} className="rise">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                    <TrendingUp size={15} color="var(--accent)" />
                    <div className="font-display" style={{ fontWeight: 800, fontSize: 13.5 }}>This month's pace</div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: 1 }}>SO FAR</div>
                      <div className="font-display tabular" style={{ fontSize: 18, fontWeight: 800, color: 'var(--money)', letterSpacing: '0.01em' }}>
                        {fmtMoney(monthTrend.mtd)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: 1 }}>ON PACE FOR</div>
                      <div className="font-display tabular" style={{ fontSize: 18, fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.01em' }}>
                        {fmtMoney(monthTrend.projected)}
                      </div>
                    </div>
                  </div>

                  <div style={{ height: 92 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={monthTrend.rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke="var(--border)" />
                        <XAxis
                          dataKey="label" tickLine={false} axisLine={false}
                          interval="preserveStartEnd" minTickGap={24}
                          tick={{ fontSize: 10.5, fill: 'var(--ink-faint)' }}
                        />
                        <YAxis
                          tickLine={false} axisLine={false} width={40}
                          tick={{ fontSize: 10, fill: 'var(--ink-faint)' }}
                          tickFormatter={(v) => `$${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}`}
                        />
                        <Tooltip
                          formatter={(v) => fmtMoney(v)}
                          labelFormatter={(l) => `Day ${l}`}
                          contentStyle={{
                            borderRadius: 12, border: '1px solid var(--border)', fontSize: 12,
                            boxShadow: 'var(--shadow-md)', background: 'var(--surface)', color: 'var(--ink)',
                          }}
                          labelStyle={{ color: 'var(--ink)', fontWeight: 700, marginBottom: 2 }}
                          itemStyle={{ color: 'var(--ink)' }}
                        />
                        <Area
                          type="monotone" dataKey="earned" stroke="var(--accent)" strokeWidth={2.4}
                          fill="url(#trendGrad)" connectNulls={false}
                          dot={false} activeDot={{ r: 4, fill: 'var(--accent)' }}
                          animationDuration={620}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 10 }}>
              {[0, 1].map(i => (
                <button
                  key={i}
                  onClick={() => {
                    const el = chartScrollRef.current;
                    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
                  }}
                  style={{
                    width: chartPage === i ? 18 : 6, height: 6, borderRadius: 3, padding: 0,
                    border: 'none', cursor: 'pointer',
                    background: chartPage === i ? 'var(--accent)' : 'var(--border)',
                    transition: 'width 220ms ease, background 220ms ease',
                  }}
                  aria-label={`Chart ${i + 1}`}
                />
              ))}
            </div>
          </div>
        )}

        {tab === 'sales' && (
          <div>
            <input
              type="date" value={saleDay || monthDayBounds.min}
              onChange={e => {
                const v = e.target.value;
                if (!v) return;
                setSaleMonth(v.slice(0, 7));
                setSaleDay(v);
              }}
              style={{ ...styles.input, marginTop: 14 }}
            />

            <div style={styles.segmentRow}>
              <button
                onClick={() => setSalesSubTab('sales')}
                style={salesSubTab === 'sales' ? styles.segmentOn : styles.segment}
              >
                Sales
              </button>
              <button
                onClick={() => setSalesSubTab('customers')}
                style={salesSubTab === 'customers' ? styles.segmentOn : styles.segment}
              >
                Customers
              </button>
            </div>

            {salesSubTab === 'sales' ? (
              <>
                {shownSales.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--ink-faint)', fontWeight: 600 }}>
                      {shownSales.length} sale{shownSales.length === 1 ? '' : 's'}
                    </span>
                    <span className="font-display tabular" style={{ fontSize: 17, fontWeight: 800, color: 'var(--money)' }}>
                      {fmtMoney(shownTotal)}
                    </span>
                  </div>
                )}

                {shownSales.length === 0 ? (
                  <EmptyState icon={DollarSign} title="No Sales" />
                ) : (
                  shownSales.map((s, i) => (
                    <div key={s.id} className="rise" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                      <SaleRow sale={s} customers={customers} onDelete={() => deleteCommission(s.id)} />
                    </div>
                  ))
                )}
              </>
            ) : (
              <>
                <div style={{ position: 'relative', marginBottom: 8 }}>
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
              </>
            )}
          </div>
        )}

        {tab === 'goals' && (
          <div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 18, marginTop: 14, marginBottom: 12, textAlign: 'center' }}>Monthly Goals</div>
            <input
              type="month" value={goalMonth} onChange={e => setGoalMonth(e.target.value)}
              style={{ ...styles.input, marginBottom: 8 }}
            />

            {(() => {
              const { list: goalList } = goalsForMonth(goals, goalMonth, employmentType);
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
                          BYOD Voice Lines never count here. BYOD Protection still counts as attached, so it lifts the rate without adding an opportunity.
                        </div>
                      )}
                      {newGoal.goalType === 'revenuePerUnit' && newGoal.baseCategoryNames.includes('Voice Line') && (
                        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', margin: '-4px 2px 8px', lineHeight: 1.4 }}>
                          BYOD Voice Lines never count here, so they can't drag this rate down.
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

                <div style={styles.adminSectionLabel}><Shield size={13} />Passcode</div>
                <div style={styles.card}>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 12, lineHeight: 1.5 }}>
                    Six digits, required after the five taps. Stays on this device.
                  </div>
                  <input
                    type="tel" inputMode="numeric" maxLength={6}
                    value={newPin} onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="New 6-digit passcode"
                    style={{ ...styles.input, marginBottom: 8, letterSpacing: '0.2em' }}
                  />
                  <button
                    style={{ ...styles.secondaryBtn, opacity: newPin.length === 6 ? 1 : 0.5 }}
                    disabled={newPin.length !== 6}
                    onClick={async () => {
                      setDevPin(newPin);
                      await persist('devPin', newPin);
                      setNewPin('');
                      flashToast('Passcode updated');
                    }}
                  >
                    <Check size={16} style={{ marginRight: 6 }} /> Save passcode
                  </button>
                </div>

              </>
            )}
          </div>
        )}
      </div>

      {/* bottom nav */}
      <div style={styles.navWrap}>
        <div style={styles.nav}>
          <NavBtn icon={Home} label="Home" active={tab === 'dashboard'} onClick={() => setTab('dashboard')} />
          <NavBtn icon={DollarSign} label="Sales" active={tab === 'sales'} onClick={() => setTab('sales')} />
          <div style={styles.navFabSlot}>
            <button className="press" style={styles.navFab} onClick={() => setShowSaleModal(true)} aria-label="Log a transaction">
              <Plus size={24} strokeWidth={2.6} color="#fff" />
            </button>
          </div>
          <NavBtn icon={TrendingUp} label="Goals" active={tab === 'goals'} onClick={() => setTab('goals')} />
          <NavBtn icon={SettingsIcon} label="Settings" active={tab === 'settings'} onClick={() => { setTab('settings'); handleRatesTap(); }} />
        </div>
      </div>

      {pinPadOpen && (
        <div style={styles.pinOverlay} onClick={() => setPinPadOpen(false)}>
          <div style={styles.pinCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.pinLockRing}>
              <Shield size={17} color="var(--accent)" strokeWidth={2.1} />
            </div>

            <div className="font-display" style={{ fontWeight: 800, fontSize: 15, marginTop: 12 }}>
              Enter Passcode
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div
                  key={i}
                  style={{
                    width: 11, height: 11, borderRadius: '50%',
                    background: i < pinEntry.length ? 'var(--accent)' : 'transparent',
                    border: `1.5px solid ${i < pinEntry.length ? 'var(--accent)' : 'var(--border)'}`,
                    transform: i < pinEntry.length ? 'scale(1.12)' : 'scale(1)',
                    transition: 'background 160ms ease, border-color 160ms ease, transform 160ms ease',
                  }}
                />
              ))}
            </div>

            <div style={{ height: 16, marginTop: 10, fontSize: 11.5, color: '#DC2626', fontWeight: 600 }}>
              {pinError}
            </div>

            <div style={styles.pinGrid}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
                <button key={d} className="press" style={styles.pinKey} onClick={() => pressPin(d)}>{d}</button>
              ))}
              <button
                className="press" style={styles.pinKeyGhost}
                onClick={() => setPinPadOpen(false)}
              >
                Cancel
              </button>
              <button className="press" style={styles.pinKey} onClick={() => pressPin('0')}>0</button>
              <button
                className="press" style={styles.pinKeyGhost}
                onClick={() => { setPinEntry(pinEntry.slice(0, -1)); setPinError(''); }}
                aria-label="Delete"
                disabled={!pinEntry.length}
              >
                <ChevronLeft size={18} strokeWidth={2.4} style={{ opacity: pinEntry.length ? 1 : 0.3 }} />
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div style={styles.toast}>{toast}</div>}

      <SaleModal
        open={showSaleModal} onClose={() => { setShowSaleModal(false); setSaleModalPlan(null); }} onSave={addCommission}
        categories={categories} initialPlan={saleModalPlan} spiffs={spiffs}
        customers={customers} onCreateCustomer={quickAddCustomer}
        onEditCustomer={(c) => setCustomerModal({ open: true, initial: c, id: c.id })}
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
    <button onClick={onClick} style={active ? styles.navBtnOn : styles.navBtn} className="press">
      <div style={styles.navIconBox}>
        <Icon size={20} color={active ? 'var(--ink)' : 'var(--ink-faint)'} strokeWidth={active ? 2.4 : 1.9} />
      </div>
      <span style={{
        fontSize: 10, fontWeight: active ? 700 : 600,
        color: active ? 'var(--ink)' : 'var(--ink-faint)', marginTop: 3, letterSpacing: '-0.01em',
      }}>
        {label}
      </span>
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
    if (it.lines > 1) parts.push(`${it.lines} lines`);
    if (qty > 1) parts.push(`Qty ${qty}`);
    if (it.alreadyProtected) parts.push('Already protected');
    if (it.isBYOD) parts.push('BYOD');
    if (it.isEssential) parts.push('Essential');
    if (it.isPriority) parts.push('Priority');
    if (it.isBTS) parts.push('BTS');
    if (it.featureRevenue > 0) parts.push(`+${fmtMoneyPlain(it.featureRevenue)} feature rev`);
    if (it.spiffAmount > 0) parts.push(`+${fmtMoneyPlain(it.spiffAmount)} SPIFF`);
    return parts.join(' \u00b7 ');
  }

  const title = multi ? `${items.length} items` : items[0].category;

  return (
    <div style={styles.saleRow} className="lift">
      <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: 'var(--accent)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ cursor: 'pointer' }} onClick={() => setExpanded(v => !v)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              {title}
            </span>
            <span className="font-display tabular" style={{ fontWeight: 800, fontSize: 14, color: 'var(--money)' }}>{fmtMoney(sale.amount)}</span>
          </div>
        </div>

        {expanded && (
          <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--border)' }}>
            {customer && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Avatar name={customer.name} size={18} />
                <span style={{ fontSize: 11.5, color: 'var(--ink-soft)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {customer.name}
                </span>
              </div>
            )}

            {items.map((it, i) => {
              const Icon = categoryIcon(it.category);
              const d = itemDetail(it);
              return (
                <div key={it.id || i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0' }}>
                  <Icon size={14} strokeWidth={2.1} color="var(--accent)" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{it.category}</div>
                    {d && <div style={{ fontSize: 10.5, color: 'var(--ink-faint)', lineHeight: 1.4 }}>{d}</div>}
                  </div>
                  <div className="font-display tabular" style={{ fontSize: 12.5, fontWeight: 700 }}>{fmtMoney(it.amount)}</div>
                </div>
              );
            })}

            {sale.notes && (
              <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', lineHeight: 1.5 }}>
                {sale.notes}
              </div>
            )}
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
  --bg: #E6E6EE;
  --surface: #FFFFFF;
  --carbon: #0D0D12;
  --carbon-2: #22222E;
  --ink: #0F0F14;
  --ink-soft: #5C5C68;
  --ink-faint: #8E8E9C;
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
  --border: #D2D2DE;
  --track: rgba(15,15,20,0.07);
  --neutral-soft: rgba(15,15,20,0.06);
  --nav-bg: rgba(255,255,255,0.92);
  --solid-btn-bg: #0D0D12;
  --solid-btn-fg: #FFFFFF;
  --shadow-sm: 0 1px 3px rgba(15,15,20,0.10), 0 1px 2px rgba(15,15,20,0.05);
  --shadow-md: 0 6px 18px rgba(15,15,20,0.13);
  --money: #0F0F14;
  --shadow-glow: 0 2px 6px rgba(226,0,116,0.22);
  color-scheme: light;
}

.theme-dark {
  --bg: #0B0B10;
  --surface: #1C1C25;
  --carbon: #05050A;
  --carbon-2: #1E1E2A;
  --ink: #F7F7FA;
  --ink-soft: #ADADBD;
  --ink-faint: #79798A;
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
  --border: #34343F;
  --track: rgba(255,255,255,0.07);
  --neutral-soft: rgba(255,255,255,0.08);
  --nav-bg: rgba(18,18,24,0.92);
  --solid-btn-bg: #2A2A36;
  --solid-btn-fg: #F2F2F6;
  --shadow-sm: 0 2px 6px rgba(0,0,0,0.6);
  --shadow-md: 0 6px 20px rgba(0,0,0,0.65);
  --money: #F7F7FA;
  --shadow-glow: 0 2px 6px rgba(255,45,158,0.22);
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

/* iOS gives date/month inputs their own native sizing that ignores width:100%,
   so they end up narrower than the cards beneath them and look misaligned.
   Resetting appearance makes them honour the same box as every other field. */
input, select, textarea {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
input[type="date"], input[type="month"] {
  display: block;
  text-align: left;
  min-height: 44px;
}
input[type="date"]::-webkit-date-and-time-value,
input[type="month"]::-webkit-date-and-time-value {
  text-align: left;
}
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

/* ------------------------------------------------------------------
   Honeycomb hex mesh — drawn entirely with CSS gradients rather than a
   bitmap, so it stays perfectly sharp at any screen density and costs a
   few hundred bytes instead of a compressed image. The two angled
   linear-gradients (30deg / 150deg) cut the slanted hex walls, the
   radial-gradients round the left/right vertices, and the vertical
   gradient closes the flat top and bottom edges. Tile ratio is locked at
   2:3 (40x60) — the radial offsets below are tuned to that size, so
   changing one without the other breaks the lattice alignment.
   ------------------------------------------------------------------ */
.app-shell.theme-dark {
  background-color: #0B0B10 !important;
  background-image:
    radial-gradient(circle farthest-side at 0% 50%, #0B0B10 23.5%, rgba(11,11,16,0) 0) 21px 30px,
    radial-gradient(circle farthest-side at 0% 50%, #2A2A3A 24%, rgba(42,42,58,0) 0) 19px 30px,
    linear-gradient(#0B0B10 14%, rgba(11,11,16,0) 0, rgba(11,11,16,0) 85%, #0B0B10 0) 0 0,
    linear-gradient(150deg, #0B0B10 24%, #2A2A3A 0, #2A2A3A 26%, rgba(11,11,16,0) 0, rgba(11,11,16,0) 74%, #2A2A3A 0, #2A2A3A 76%, #0B0B10 0) 0 0,
    linear-gradient(30deg, #0B0B10 24%, #2A2A3A 0, #2A2A3A 26%, rgba(11,11,16,0) 0, rgba(11,11,16,0) 74%, #2A2A3A 0, #2A2A3A 76%, #0B0B10 0) 0 0,
    linear-gradient(90deg, #2A2A3A 2%, #0B0B10 0, #0B0B10 98%, #2A2A3A 0) 0 0 !important;
  background-size: 40px 60px !important;
  background-attachment: scroll !important;
}

/* Light mode counterpart — identical hex geometry, recolored pale so it
   reads as a soft embossed texture rather than a bright copy of the dark
   version. Cards keep their own solid surfaces, so this only ever shows
   in the gaps around and between content. */
.app-shell:not(.theme-dark) {
  background-color: #E6E6EE !important;
  background-image:
    radial-gradient(circle farthest-side at 0% 50%, #E6E6EE 23.5%, rgba(230,230,238,0) 0) 21px 30px,
    radial-gradient(circle farthest-side at 0% 50%, #C6C6D6 24%, rgba(198,198,214,0) 0) 19px 30px,
    linear-gradient(#E6E6EE 14%, rgba(230,230,238,0) 0, rgba(230,230,238,0) 85%, #E6E6EE 0) 0 0,
    linear-gradient(150deg, #E6E6EE 24%, #C6C6D6 0, #C6C6D6 26%, rgba(230,230,238,0) 0, rgba(230,230,238,0) 74%, #C6C6D6 0, #C6C6D6 76%, #E6E6EE 0) 0 0,
    linear-gradient(30deg, #E6E6EE 24%, #C6C6D6 0, #C6C6D6 26%, rgba(230,230,238,0) 0, rgba(230,230,238,0) 74%, #C6C6D6 0, #C6C6D6 76%, #E6E6EE 0) 0 0,
    linear-gradient(90deg, #C6C6D6 2%, #E6E6EE 0, #E6E6EE 98%, #C6C6D6 0) 0 0 !important;
  background-size: 40px 60px !important;
  background-attachment: scroll !important;
}

/* The mesh is deliberately low-contrast, but cards and text still sit on
   their own solid surfaces, so nothing reads through them. */

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
    color: 'var(--ink)', position: 'relative', overflow: 'hidden',
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
  flagToggleOff: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 10,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    color: 'var(--ink-soft)', background: 'transparent',
    border: '1.5px dashed var(--border)', borderRadius: 13, padding: '10px 12px',
    transition: 'all 180ms ease',
  },
  flagToggleOn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 10,
    fontSize: 13, fontWeight: 800, cursor: 'pointer', color: '#fff',
    background: 'linear-gradient(135deg, var(--accent-2) 0%, var(--accent) 60%, var(--accent-deep) 100%)',
    border: '1.5px solid transparent', borderRadius: 13, padding: '10px 12px',
    boxShadow: '0 2px 6px rgba(226,0,116,0.22)',
    transition: 'all 180ms ease',
  },
  flagMarkOff: {
    width: 18, height: 18, borderRadius: 6, flexShrink: 0,
    border: '1.5px solid var(--ink-faint)', background: 'transparent',
  },
  flagMarkOn: {
    width: 18, height: 18, borderRadius: 6, flexShrink: 0,
    border: '1.5px solid rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.22)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
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
  addCustomerBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    width: 38, height: 38, borderRadius: 11, border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--ink-soft)', cursor: 'pointer',
    boxShadow: 'var(--shadow-sm)', transition: 'all 150ms ease',
  },
  chip: {
    padding: '9px 14px', borderRadius: 11, border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--ink-soft)', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    boxShadow: 'var(--shadow-sm)', transition: 'all 150ms ease',
  },
  chipOn: {
    padding: '9px 14px', borderRadius: 11, border: '1px solid var(--accent)', background: 'var(--accent)',
    color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
    boxShadow: '0 2px 6px rgba(226,0,116,0.22)', transition: 'all 150ms ease',
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
    boxShadow: '0 2px 6px rgba(226,0,116,0.22)', transition: 'all 150ms ease',
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

  navFabSlot: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  navFab: {
    width: 46, height: 46, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg, var(--accent-2) 0%, var(--accent) 55%, var(--accent-deep) 100%)',
    border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 6px rgba(226,0,116,0.22)', cursor: 'pointer',
  },

  navWrap: {
    flexShrink: 0, padding: '6px 12px calc(10px + env(safe-area-inset-bottom))',
    background: 'transparent',
  },
  nav: {
    display: 'flex', alignItems: 'center', gap: 2,
    background: 'var(--nav-bg)', border: '1px solid var(--border)',
    backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    borderRadius: 999, padding: '6px 8px',
    boxShadow: '0 6px 22px rgba(0,0,0,0.28)',
  },
  chartCarousel: {
    display: 'flex', overflowX: 'auto', overflowY: 'hidden',
    scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch',
    alignItems: 'stretch',
  },
  chartSlide: {
    flex: '0 0 100%', width: '100%', scrollSnapAlign: 'start', minWidth: 0,
  },
  segmentRow: {
    display: 'flex', gap: 4, marginTop: 8, marginBottom: 8,
    background: 'var(--track)', padding: 4, borderRadius: 15,
  },
  segment: {
    flex: 1, padding: '9px 0', borderRadius: 11, border: 'none', background: 'transparent',
    color: 'var(--ink-soft)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
    transition: 'background 180ms ease, color 180ms ease',
  },
  segmentOn: {
    flex: 1, padding: '9px 0', borderRadius: 11, border: 'none', background: 'var(--surface)',
    color: 'var(--ink)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
    boxShadow: 'var(--shadow-sm)', transition: 'background 180ms ease, color 180ms ease',
  },
  navIconBox: {
    width: 24, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  navBtn: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', border: 'none',
    background: 'none', cursor: 'pointer', padding: '7px 0 6px', position: 'relative',
    borderRadius: 999, transition: 'background 200ms ease',
  },
  navBtnOn: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', border: 'none',
    background: 'var(--track)', cursor: 'pointer', padding: '7px 0 6px', position: 'relative',
    borderRadius: 999, transition: 'background 200ms ease',
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

  pinOverlay: {
    position: 'absolute', inset: 0, zIndex: 40,
    background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  pinCard: {
    width: '100%', maxWidth: 300, background: 'var(--surface)', borderRadius: 24,
    border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)',
    padding: '24px 22px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center',
  },
  pinLockRing: {
    width: 46, height: 46, borderRadius: '50%', background: 'var(--accent-soft)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  pinGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
    width: '100%', marginTop: 4, justifyItems: 'center',
  },
  pinKey: {
    width: 62, height: 62, borderRadius: '50%',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--ink)', fontSize: 21, fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontVariantNumeric: 'tabular-nums', transition: 'background 140ms ease',
  },
  pinKeyGhost: {
    width: 62, height: 62, borderRadius: '50%',
    border: 'none', background: 'transparent',
    color: 'var(--ink-soft)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  toast: {
    position: 'absolute', bottom: 96, left: '50%', transform: 'translateX(-50%)', background: 'var(--carbon)',
    color: '#fff', padding: '10px 16px', borderRadius: 12, fontSize: 12.5, fontWeight: 600,
    boxShadow: 'var(--shadow-md)', zIndex: 30, maxWidth: '82%', textAlign: 'center', lineHeight: 1.4,
  },

  deleteLink: {
    display: 'block', width: '100%', textAlign: 'center', marginTop: 10, padding: '9px 0',
    background: 'none', border: 'none', color: '#DC2626', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
};
