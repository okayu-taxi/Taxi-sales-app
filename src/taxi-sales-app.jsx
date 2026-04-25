import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense, memo } from "react";
import { getPat, setPat, getGistId, setGistId, validatePat, findExistingGist, createGist, pushToGist, pullFromGist } from "./gistSync";

const LazyChart = lazy(() => import("./SalesChart"));

const STORAGE_KEY = "taxi_sales_data_v3";

const DEFAULT_COMMISSION = {
  tiers: [], // [{ threshold: number(税込), rate: number(%)}]
  attendanceTable: [], // [{ work, paid, absent, target }] — 一致した行があれば最高歩合の足切りを target に置き換え
};

function applyAttendanceAdjust(tiers, periodAtt, conf) {
  const sorted = sortTiers(tiers);
  if (sorted.length === 0) return sorted;
  const table = conf?.attendanceTable || [];
  const match = table.find(e =>
    (Number(e.work) || 0) === (periodAtt?.work || 0) &&
    (Number(e.paid) || 0) === (periodAtt?.paid || 0) &&
    (Number(e.absent) || 0) === (periodAtt?.absent || 0)
  );
  if (!match || !(Number(match.target) > 0)) return sorted;
  const out = [...sorted];
  const last = out[out.length - 1];
  out[out.length - 1] = { ...last, threshold: Number(match.target) };
  return out;
}

function sortTiers(tiers) {
  return [...(tiers || [])].sort((a, b) => (a.threshold || 0) - (b.threshold || 0));
}

function getCommissionRate(revenue, conf = DEFAULT_COMMISSION) {
  const tiers = sortTiers(conf?.tiers);
  if (tiers.length === 0) return 0;
  let rate = 0;
  for (const t of tiers) {
    if (revenue >= (t.threshold || 0)) rate = t.rate || 0;
    else break;
  }
  return rate;
}
function toTaxInc(amount) {
  return Math.ceil(amount * 1.1 / 10) * 10;
}
function estimateSalary(revenue, conf = DEFAULT_COMMISSION) {
  return Math.round(revenue * getCommissionRate(revenue, conf) / 100);
}
function topTier(conf) {
  const tiers = sortTiers(conf?.tiers);
  return tiers.length > 0 ? tiers[tiers.length - 1] : null;
}

function getDaysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
function getFirstDayOfWeek(year, month) { return new Date(year, month, 1).getDay(); }
function getPeriod(year, month, closingDay) {
  if (closingDay === 0) return { startYear: year, startMonth: month, startDay: 1, endYear: year, endMonth: month, endDay: getDaysInMonth(year, month), label: `${year}年${month + 1}月` };
  const thisDays = getDaysInMonth(year, month);
  const endDay = Math.min(closingDay, thisDays);
  let sm = month - 1, sy = year;
  if (sm < 0) { sm = 11; sy = year - 1; }
  const prevDays = getDaysInMonth(sy, sm);
  let startYear, startMonth, startDay;
  if (closingDay >= prevDays) {
    startYear = year; startMonth = month; startDay = 1;
  } else {
    startYear = sy; startMonth = sm; startDay = closingDay + 1;
  }
  const label = `${startYear}年${startMonth + 1}月${startDay}日〜${year}年${month + 1}月${endDay}日`;
  return { startYear, startMonth, startDay, endYear: year, endMonth: month, endDay, label };
}
function getDatesInPeriod(period) {
  const dates = [];
  let y = period.startYear, m = period.startMonth, d = period.startDay;
  for (let i = 0; i < 62; i++) {
    dates.push({ year: y, month: m, day: d });
    if (y === period.endYear && m === period.endMonth && d === period.endDay) break;
    d++; if (d > getDaysInMonth(y, m)) { d = 1; m++; if (m > 11) { m = 0; y++; } }
  }
  return dates;
}

const WEEKDAYS = ["日","月","火","水","木","金","土"];

function getNow() { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth(), day: n.getDate() }; }
function getCorrectPeriod(closingDay) {
  const n = getNow();
  if (closingDay > 0) {
    const effective = Math.min(closingDay, getDaysInMonth(n.year, n.month));
    if (n.day > effective) {
      return { year: n.month === 11 ? n.year + 1 : n.year, month: (n.month + 1) % 12 };
    }
  }
  return { year: n.year, month: n.month };
}
function readClosingDay() {
  try { const s = localStorage.getItem(STORAGE_KEY); return (s ? JSON.parse(s) : null)?.settings?.closingDay ?? 0; }
  catch { return 0; }
}

const _now = new Date();
const today = { year: _now.getFullYear(), month: _now.getMonth(), day: _now.getDate() };

function migrateData(d) {
  if (!d) return { settings: { closingDay: 0, commission: { tiers: [] } }, periods: {}, attendance: {} };
  d.settings = d.settings || {};
  // Initialize commission as empty (no auto-migration of legacy values)
  if (!d.settings.commission || !Array.isArray(d.settings.commission.tiers)) {
    d.settings.commission = { tiers: [], attendanceTable: [] };
  } else if (!Array.isArray(d.settings.commission.attendanceTable)) {
    d.settings.commission.attendanceTable = [];
  }
  if (d.attendance) {
    const mig = {};
    Object.entries(d.attendance).forEach(([k, v]) => {
      if (v === true) mig[k] = 'work';
      else if (typeof v === 'string') mig[k] = v;
    });
    d.attendance = mig;
  }
  if (d.periods) {
    Object.values(d.periods).forEach(p => {
      if (!p?.days) return;
      Object.keys(p.days).forEach(dk => {
        const v = p.days[dk];
        if (typeof v === "number") p.days[dk] = { sales: v, toll: 0 };
        else if (v && typeof v === "object") p.days[dk] = { sales: v.sales || 0, toll: v.toll || 0 };
      });
    });
  }
  return d;
}

export default function TaxiSalesApp() {
  const [curYear, setCurYear] = useState(() => getCorrectPeriod(readClosingDay()).year);
  const [curMonth, setCurMonth] = useState(() => getCorrectPeriod(readClosingDay()).month);
  const [calYear, setCalYear] = useState(today.year);
  const [calMonth, setCalMonth] = useState(today.month);
  const [activeTab, setActiveTab] = useState("home");
  const [inputAmount, setInputAmount] = useState("");
  const [inputToll, setInputToll] = useState("");
  const [inputDateKey, setInputDateKey] = useState("");
  const [inputTollDateKey, setInputTollDateKey] = useState("");
  const [goalInput, setGoalInput] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [editingClosing, setEditingClosing] = useState(false);
  const [closingInput, setClosingInput] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const swipeRef = useRef(null);
  const [visitedTabs, setVisitedTabs] = useState(() => new Set(["home"]));
  useEffect(() => { setVisitedTabs(prev => prev.has(activeTab) ? prev : new Set([...prev, activeTab])); }, [activeTab]);

  const [data, setData] = useState(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); return migrateData(s ? JSON.parse(s) : null); }
    catch { return { settings: { closingDay: 0 }, periods: {}, attendance: {} }; }
  });

  const closingDay = data.settings?.closingDay ?? 0;
  const attendance = data.attendance || {};

  const period = useMemo(() => getPeriod(curYear, curMonth, closingDay), [curYear, curMonth, closingDay]);
  const pKey = useMemo(() => `${period.startYear}-${period.startMonth}-${period.startDay}_${period.endYear}-${period.endMonth}-${period.endDay}`, [period]);
  const pData = useMemo(() => data.periods?.[pKey] || { goal: 0, days: {} }, [data.periods, pKey]);
  const datesInPeriod = useMemo(() => getDatesInPeriod(period), [pKey]);

  const periodAtt = useMemo(() => {
    let work = 0, paid = 0, absent = 0;
    datesInPeriod.forEach(d => {
      const v = attendance[`${d.year}-${d.month}-${d.day}`];
      if (v === 'work') work++;
      else if (v === 'paid_leave') paid++;
      else if (v === 'absent') absent++;
    });
    return { work, paid, absent };
  }, [datesInPeriod, attendance]);

  const commission = useMemo(() => ({ ...DEFAULT_COMMISSION, ...(data.settings?.commission || {}) }), [data.settings?.commission]);
  const sortedTiers = useMemo(() => applyAttendanceAdjust(commission.tiers, periodAtt, commission), [commission, periodAtt]);
  const topRateTier = useMemo(() => sortedTiers.length > 0 ? sortedTiers[sortedTiers.length - 1] : null, [sortedTiers]);
  const targetTop = topRateTier?.threshold || 0;
  const effectiveCommission = useMemo(() => ({ ...commission, tiers: sortedTiers }), [commission, sortedTiers]);

  useEffect(() => {
    const tin = datesInPeriod.find(d => d.year === today.year && d.month === today.month && d.day === today.day);
    const def = tin || datesInPeriod[0];
    if (def) { const k = `${def.year}-${def.month}-${def.day}`; setInputDateKey(k); setInputTollDateKey(k); }
  }, [pKey]);

  const isFirstSaveRef = useRef(true);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
    if (isFirstSaveRef.current) { isFirstSaveRef.current = false; }
  }, [data]);

  // ── Gist sync ──
  const [pat, setPatState] = useState(() => getPat());
  const [gistId, setGistIdState] = useState(() => getGistId());
  const [syncStatus, setSyncStatus] = useState({ kind: "idle", msg: "" });
  const [readyToSync, setReadyToSync] = useState(false);
  const lastPushedRef = useRef(null);

  // Initial pull on mount (only when PAT+gistId exist)
  useEffect(() => {
    if (!pat || !gistId) { setReadyToSync(true); return; }
    let cancelled = false;
    (async () => {
      setSyncStatus({ kind: "syncing", msg: "サーバから取得中…" });
      try {
        const { data: remote } = await pullFromGist(pat, gistId);
        if (cancelled) return;
        const localRaw = localStorage.getItem(STORAGE_KEY);
        const local = localRaw ? JSON.parse(localRaw) : null;
        const localEmpty = !local || ((Object.keys(local.periods || {}).length === 0) && (Object.keys(local.attendance || {}).length === 0));
        if (localEmpty && remote) {
          const migrated = migrateData(remote);
          setData(migrated);
          lastPushedRef.current = JSON.stringify(migrated);
          setSyncStatus({ kind: "ok", msg: "サーバから復元しました" });
        } else {
          lastPushedRef.current = JSON.stringify(local);
          setSyncStatus({ kind: "ok", msg: `同期済 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` });
        }
      } catch (e) {
        if (!cancelled) setSyncStatus({ kind: "error", msg: `取得失敗: ${e.message}` });
      } finally {
        if (!cancelled) setReadyToSync(true);
      }
    })();
    return () => { cancelled = true; };
  }, [pat, gistId]);

  // Auto push on data change (debounced 2s)
  useEffect(() => {
    if (!pat || !gistId || !readyToSync) return;
    if (isFirstSaveRef.current) return;
    const json = JSON.stringify(data);
    if (lastPushedRef.current === json) return;
    const t = setTimeout(async () => {
      setSyncStatus({ kind: "syncing", msg: "同期中…" });
      try {
        await pushToGist(pat, gistId, data);
        lastPushedRef.current = json;
        setSyncStatus({ kind: "ok", msg: `同期済 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` });
      } catch (e) {
        setSyncStatus({ kind: "error", msg: `同期失敗: ${e.message}` });
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [data, pat, gistId, readyToSync]);

  const setupSync = useCallback(async (newPat) => {
    setSyncStatus({ kind: "syncing", msg: "PAT検証中…" });
    try {
      await validatePat(newPat);
      const found = await findExistingGist(newPat);
      if (found) {
        const restore = window.confirm(
          `既存のバックアップが見つかりました。\nGist: ${found.id}\n\n「OK」を押すとサーバから復元します。\n「キャンセル」で現在のローカルデータをサーバに上書きします。`
        );
        if (restore) {
          const { data: remote } = await pullFromGist(newPat, found.id);
          const migrated = migrateData(remote);
          setData(migrated);
          lastPushedRef.current = JSON.stringify(migrated);
        } else {
          await pushToGist(newPat, found.id, data);
          lastPushedRef.current = JSON.stringify(data);
        }
        setPat(newPat); setGistId(found.id);
        setPatState(newPat); setGistIdState(found.id);
        setSyncStatus({ kind: "ok", msg: "同期設定完了" });
      } else {
        const created = await createGist(newPat, data);
        setPat(newPat); setGistId(created.id);
        setPatState(newPat); setGistIdState(created.id);
        lastPushedRef.current = JSON.stringify(data);
        setSyncStatus({ kind: "ok", msg: "新しい Gist を作成しました" });
      }
    } catch (e) {
      setSyncStatus({ kind: "error", msg: `失敗: ${e.message}` });
      throw e;
    }
  }, [data]);

  const disconnectSync = useCallback(() => {
    if (!window.confirm("同期を解除します。サーバ上のデータは残ります。")) return;
    setPat(""); setGistId("");
    setPatState(""); setGistIdState("");
    setSyncStatus({ kind: "idle", msg: "" });
    lastPushedRef.current = null;
  }, []);

  const manualSync = useCallback(async () => {
    if (!pat || !gistId) return;
    setSyncStatus({ kind: "syncing", msg: "手動同期中…" });
    try {
      await pushToGist(pat, gistId, data);
      lastPushedRef.current = JSON.stringify(data);
      setSyncStatus({ kind: "ok", msg: `同期済 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` });
    } catch (e) {
      setSyncStatus({ kind: "error", msg: `失敗: ${e.message}` });
    }
  }, [pat, gistId, data]);

  useEffect(() => {
    const onPageShow = () => {
      const { year, month } = getCorrectPeriod(readClosingDay());
      setCurYear(year); setCurMonth(month);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const updPeriod = useCallback((np) => setData(p => ({ ...p, periods: { ...p.periods, [pKey]: np } })), [pKey]);
  const saveSales = useCallback(() => {
    const s = parseInt(inputAmount.replace(/,/g, ""));
    if (!s || isNaN(s)) return;
    const cur = pData.days[inputDateKey] || { sales: 0, toll: 0 };
    updPeriod({ ...pData, days: { ...pData.days, [inputDateKey]: { ...cur, sales: s } } });
    setInputAmount("");
  }, [inputAmount, inputDateKey, pData, updPeriod]);

  const saveToll = useCallback(() => {
    const tStr = inputToll.replace(/,/g, "").trim();
    if (tStr === "") return;
    const t = parseInt(tStr);
    if (isNaN(t) || t < 0) return;
    const cur = pData.days[inputTollDateKey];
    const next = cur ? { ...cur, toll: t } : { toll: t };
    updPeriod({ ...pData, days: { ...pData.days, [inputTollDateKey]: next } });
    setInputToll("");
  }, [inputToll, inputTollDateKey, pData, updPeriod]);
  const saveGoal = useCallback(() => { const g = parseInt(goalInput.replace(/,/g, "")); if (!g || isNaN(g)) return; updPeriod({ ...pData, goal: g }); setGoalInput(""); setEditingGoal(false); }, [goalInput, pData, updPeriod]);
  const autoSetGoalTop = useCallback(() => {
    if (!targetTop) return;
    const newGoal = targetTop;
    setData(p => ({
      ...p,
      periods: {
        ...p.periods,
        [pKey]: { ...(p.periods?.[pKey] || { days: {} }), goal: newGoal }
      }
    }));
  }, [targetTop, pKey]);
  const deleteDay = useCallback((key) => { const nd = { ...pData.days }; delete nd[key]; updPeriod({ ...pData, days: nd }); }, [pData, updPeriod]);

  const deleteSales = useCallback(() => {
    const cur = pData.days[inputDateKey];
    if (!cur) return;
    const days = { ...pData.days };
    if (cur.toll) {
      const next = { ...cur }; delete next.sales;
      days[inputDateKey] = next;
    } else {
      delete days[inputDateKey];
    }
    updPeriod({ ...pData, days });
    setInputAmount("");
  }, [inputDateKey, pData, updPeriod]);

  const deleteToll = useCallback(() => {
    const cur = pData.days[inputTollDateKey];
    if (!cur?.toll) return;
    const days = { ...pData.days };
    if (cur.sales) {
      const next = { ...cur }; delete next.toll;
      days[inputTollDateKey] = next;
    } else {
      delete days[inputTollDateKey];
    }
    updPeriod({ ...pData, days });
    setInputToll("");
  }, [inputTollDateKey, pData, updPeriod]);
  const saveClosing = useCallback(() => { const v = parseInt(closingInput); if (isNaN(v) || v < 0 || v > 31) return; setData(p => ({ ...p, settings: { ...p.settings, closingDay: v } })); setClosingInput(""); setEditingClosing(false); }, [closingInput]);

  const saveCommission = useCallback((conf) => {
    setData(p => ({ ...p, settings: { ...p.settings, commission: { ...DEFAULT_COMMISSION, ...(p.settings?.commission || {}), ...conf } } }));
  }, []);
  const saveAttendanceTable = useCallback((table) => {
    setData(p => ({ ...p, settings: { ...p.settings, commission: { ...DEFAULT_COMMISSION, ...(p.settings?.commission || {}), attendanceTable: table } } }));
  }, []);

  const toggleAtt = useCallback((y, m, d) => {
    const key = `${y}-${m}-${d}`;
    setData(p => {
      const na = { ...p.attendance };
      const cur = na[key];
      if (!cur) na[key] = 'work';
      else if (cur === 'work') na[key] = 'paid_leave';
      else if (cur === 'paid_leave') na[key] = 'absent';
      else delete na[key];
      return { ...p, attendance: na };
    });
  }, []);

  const getAttState = useCallback((y, m, d) => attendance[`${y}-${m}-${d}`] || null, [attendance]);

  const total = useMemo(() => Object.values(pData.days).reduce((a, b) => a + (b?.sales || 0), 0), [pData.days]);
  const tollTotal = useMemo(() => Object.values(pData.days).reduce((a, b) => a + (b?.toll || 0), 0), [pData.days]);
  const goal = pData.goal || 0;
  const remaining = Math.max(0, goal - total);
  const commissionRate = useMemo(() => getCommissionRate(total, effectiveCommission), [total, effectiveCommission]);
  const estimatedSalary = useMemo(() => estimateSalary(total, effectiveCommission), [total, effectiveCommission]);

  const { daysLeft, totalDays, todayIndex } = useMemo(() => {
    const idx = datesInPeriod.findIndex(d => d.year === today.year && d.month === today.month && d.day === today.day);
    return { daysLeft: idx === -1 ? 0 : datesInPeriod.length - idx, totalDays: datesInPeriod.length, todayIndex: idx };
  }, [datesInPeriod]);

  const attLeft = useMemo(() => datesInPeriod.filter(d => {
    const key = `${d.year}-${d.month}-${d.day}`;
    return attendance[key] === 'work' && new Date(d.year, d.month, d.day) >= new Date(today.year, today.month, today.day);
  }).length, [datesInPeriod, attendance]);

  const hasAtt = Object.values(attendance).some(v => v === 'work');
  const effLeft = hasAtt ? attLeft : daysLeft;
  const dailyNeeded = effLeft > 0 ? Math.ceil(remaining / effLeft) : 0;
  const pct = goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0;

  const chartData = useMemo(() => {
    return datesInPeriod.map(d => {
      const key = `${d.year}-${d.month}-${d.day}`;
      const v = pData.days[key];
      const sales = v?.sales;
      const toll = v?.toll;
      const dow = WEEKDAYS[new Date(d.year, d.month, d.day).getDay()];
      return {
        label: `${d.day}(${dow})`,
        売上: sales && sales > 0 ? sales : null,
        自腹高速: toll && toll > 0 ? toll : null,
        dateKey: key,
      };
    });
  }, [datesInPeriod, pData.days]);

  const recordedDaysCount = useMemo(() => Object.values(pData.days).filter(v => v?.sales > 0).length, [pData.days]);
  const avgSoFar = recordedDaysCount > 0 ? Math.round(total / recordedDaysCount) : 0;

  const workedDaysSoFar = useMemo(() => {
    const t = new Date(today.year, today.month, today.day);
    return datesInPeriod.filter(d => {
      const key = `${d.year}-${d.month}-${d.day}`;
      return attendance[key] === 'work' && new Date(d.year, d.month, d.day) <= t;
    }).length;
  }, [datesInPeriod, attendance]);

  const onChartPointClick = useCallback((dateKey) => {
    setInputDateKey(dateKey);
    const existing = pData.days[dateKey];
    setInputAmount(existing?.sales != null ? String(existing.sales) : "");
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        const el = document.getElementById("sales-input-card");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, [pData.days]);

  const prevPeriod = useCallback(() => { if (curMonth === 0) { setCurMonth(11); setCurYear(y => y - 1); } else setCurMonth(m => m - 1); }, [curMonth]);
  const nextPeriod = useCallback(() => { if (curMonth === 11) { setCurMonth(0); setCurYear(y => y + 1); } else setCurMonth(m => m + 1); }, [curMonth]);
  const prevCal = useCallback(() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m => m - 1); }, [calMonth]);
  const nextCal = useCallback(() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); } else setCalMonth(m => m + 1); }, [calMonth]);

  const fmt = (n) => n.toLocaleString("ja-JP");
  const closingLabel = closingDay === 0 ? "末日締め" : `毎月${closingDay}日締め`;

  const { calDays, calFirst, calCells, calWorkCount, calPaidCount } = useMemo(() => {
    const calDays = getDaysInMonth(calYear, calMonth);
    const calFirst = getFirstDayOfWeek(calYear, calMonth);
    const calCells = [...Array(calFirst).fill(null), ...Array.from({length: calDays}, (_, i) => i + 1)];
    let calWorkCount = 0, calPaidCount = 0;
    Array.from({length: calDays}, (_, i) => i + 1).forEach(d => {
      const v = attendance[`${calYear}-${calMonth}-${d}`];
      if (v === 'work') calWorkCount++;
      else if (v === 'paid_leave') calPaidCount++;
    });
    return { calDays, calFirst, calCells, calWorkCount, calPaidCount };
  }, [calYear, calMonth, attendance]);

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f7", color: "#111", fontFamily: "'Noto Sans JP', -apple-system, sans-serif", maxWidth: 480, margin: "0 auto", paddingBottom: 80 }}>

      <div style={{ background: "#fff", padding: "8px 16px 6px", borderBottom: "1px solid #ebebeb", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={prevPeriod} style={navBtn}>‹</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: closingDay === 0 ? 17 : 13, fontWeight: 700, color: "#111", lineHeight: 1.2 }}>{period.label}</div>
            <div style={{ fontSize: 10, color: "#ccc" }}>{closingLabel}</div>
          </div>
          <button onClick={nextPeriod} style={navBtn}>›</button>
        </div>
        {pat && gistId && (
          <div style={{ position: "absolute", right: 8, top: 4, fontSize: 9, color: syncStatus.kind === "error" ? "#e55" : syncStatus.kind === "syncing" ? "#c8900a" : "#3399ff", fontWeight: 600 }}>
            {syncStatus.kind === "syncing" ? "⟳" : syncStatus.kind === "error" ? "⚠" : "☁︎"}
          </div>
        )}
      </div>

      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #ebebeb" }}>
        {[["home","ホーム"],["calendar","出番表"],["graph","歩合率設定"],["settings","システム設定"]].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ flex: 1, padding: "7px 0", border: "none", background: "none", color: activeTab === key ? "#111" : "#ccc", fontWeight: activeTab === key ? 700 : 400, fontSize: 11, cursor: "pointer", borderBottom: activeTab === key ? "2px solid #111" : "2px solid transparent", transition: "all 0.15s" }}>{label}</button>
        ))}
      </div>

      <div
        style={{ padding: "10px 12px" }}
        onTouchStart={(e) => {
          let el = e.target;
          while (el && el !== e.currentTarget) {
            const tag = el.tagName;
            if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") { swipeRef.current = null; return; }
            const cs = window.getComputedStyle(el);
            if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 2) { swipeRef.current = null; return; }
            el = el.parentElement;
          }
          const t = e.touches[0];
          swipeRef.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const s = swipeRef.current;
          if (!s) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - s.x;
          const dy = t.clientY - s.y;
          swipeRef.current = null;
          if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
          const tabs = ["home", "calendar", "graph", "settings"];
          const idx = tabs.indexOf(activeTab);
          if (dx < 0 && idx < tabs.length - 1) setActiveTab(tabs[idx + 1]);
          else if (dx > 0 && idx > 0) setActiveTab(tabs[idx - 1]);
        }}
      >

        {visitedTabs.has("home") && <div style={{ display: activeTab === "home" ? "block" : "none" }}>

          {/* 2x2 統計グリッド */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div style={statCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={statTitle}>今月の目標</span>
                <button onClick={() => { setEditingGoal(!editingGoal); setGoalInput(""); }} style={miniBtn}>{editingGoal ? "×" : "編集"}</button>
              </div>
              {editingGoal ? (
                <>
                  <input type="number" placeholder="目標額" value={goalInput} onChange={e => setGoalInput(e.target.value)} style={{ ...inputStyle, fontSize: 16, padding: "6px 8px", marginTop: 4 }} onKeyDown={e => e.key === "Enter" && saveGoal()} />
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <button onClick={saveGoal} style={{ ...primaryBtn, flex: 1, padding: "5px", fontSize: 12 }}>保存</button>
                    {topRateTier && targetTop > 0 && <button onClick={autoSetGoalTop} style={{ ...ghostBtn, flex: 1, padding: "5px", fontSize: 11, color: "#c8900a", borderColor: "#F6BE00" }}>{topRateTier.rate}%自動</button>}
                  </div>
                </>
              ) : (
                <>
                  <div style={statValue}>¥{fmt(goal)}</div>
                  <div style={{ background: "#eee", borderRadius: 99, height: 4, overflow: "hidden", marginTop: 4 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: "#3399ff", transition: "width 0.4s" }} />
                  </div>
                  <div style={{ ...statSub, marginTop: 2 }}>達成率 {pct}%</div>
                </>
              )}
            </div>
            <div style={statCard}>
              <div style={statTitle}>目標まで残り</div>
              <div style={statValue}>¥{fmt(remaining)}</div>
              <div style={{ fontSize: 10, color: "#999", marginTop: 4 }}>目標までの1日平均</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#333" }}>¥{fmt(dailyNeeded)}</div>
            </div>
            <div style={statCard}>
              <div style={statTitle}>現在の総営収</div>
              <div style={statValue}>¥{fmt(total)}</div>
            </div>
            <div style={statCard}>
              <div style={statTitle}>今日までの1日平均</div>
              <div style={statValue}>¥{fmt(avgSoFar)}</div>
            </div>
          </div>

          {/* 日別売上グラフ */}
          <div style={{ ...card, padding: "10px 10px 6px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, padding: "0 4px" }}>
              <span style={{ fontSize: 11, color: "#999", fontWeight: 600 }}>日報毎のデータ</span>
              <span style={{ fontSize: 10, color: "#bbb" }}>日付タップで編集</span>
            </div>
            <Suspense fallback={<div style={{ height: 170, display: "flex", alignItems: "center", justifyContent: "center", color: "#ccc", fontSize: 12 }}>グラフを読み込み中…</div>}>
              <LazyChart chartData={chartData} totalDays={totalDays} fmt={fmt} onPointClick={onChartPointClick} todayIndex={todayIndex} />
            </Suspense>
          </div>

          {/* 売上入力カード */}
          <div id="sales-input-card" style={{ ...card, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ ...lbl, fontSize: 9 }}>売上を入力</span>
              {pData.days[inputDateKey] != null && (
                <span style={{ fontSize: 10, color: "#3399ff", fontWeight: 700 }}>編集中</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              <select value={inputDateKey} onChange={e => { setInputDateKey(e.target.value); const v = pData.days[e.target.value]; setInputAmount(v?.sales != null ? String(v.sales) : ""); }} style={{ ...inputStyle, width: 150, flex: "none", padding: "8px", fontSize: 16, boxSizing: "border-box" }}>
                {datesInPeriod.map(d => { const k = `${d.year}-${d.month}-${d.day}`; const w = WEEKDAYS[new Date(d.year, d.month, d.day).getDay()]; return <option key={k} value={k}>{d.month+1}月{d.day}日({w})</option>; })}
              </select>
              <input type="number" placeholder="売上（円）" value={inputAmount} onChange={e => setInputAmount(e.target.value)} style={{ ...inputStyle, padding: "8px 10px", minWidth: 0, boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && saveSales()} />
              <button onClick={saveSales} style={{ ...primaryBtn, padding: "8px 14px", flex: "none", whiteSpace: "nowrap" }}>{pData.days[inputDateKey]?.sales ? "更新" : "記録"}</button>
              {pData.days[inputDateKey]?.sales > 0 && (
                <button onClick={deleteSales} style={{ ...ghostBtn, padding: "8px 10px", color: "#e55", borderColor: "#f5c8c8", flex: "none", whiteSpace: "nowrap" }}>削除</button>
              )}
            </div>
          </div>

          {/* 自腹高速入力カード */}
          <div style={{ ...card, padding: "10px 12px", marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ ...lbl, fontSize: 9 }}>自腹高速を入力</span>
              {pData.days[inputTollDateKey]?.toll ? (
                <span style={{ fontSize: 10, color: "#3399ff", fontWeight: 700 }}>編集中</span>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "stretch", marginBottom: 8 }}>
              <select value={inputTollDateKey} onChange={e => { setInputTollDateKey(e.target.value); const v = pData.days[e.target.value]; setInputToll(v?.toll ? String(v.toll) : ""); }} style={{ ...inputStyle, width: 150, flex: "none", padding: "8px", fontSize: 16, boxSizing: "border-box" }}>
                {datesInPeriod.map(d => { const k = `${d.year}-${d.month}-${d.day}`; const w = WEEKDAYS[new Date(d.year, d.month, d.day).getDay()]; return <option key={k} value={k}>{d.month+1}月{d.day}日({w})</option>; })}
              </select>
              <input type="number" placeholder="自腹高速（円）" value={inputToll} onChange={e => setInputToll(e.target.value)} style={{ ...inputStyle, padding: "8px 10px", minWidth: 0, boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && saveToll()} />
              <button onClick={saveToll} style={{ ...primaryBtn, padding: "8px 14px", flex: "none", whiteSpace: "nowrap" }}>{pData.days[inputTollDateKey]?.toll ? "更新" : "記録"}</button>
              {pData.days[inputTollDateKey]?.toll > 0 && (
                <button onClick={deleteToll} style={{ ...ghostBtn, padding: "8px 10px", color: "#e55", borderColor: "#f5c8c8", flex: "none", whiteSpace: "nowrap" }}>削除</button>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 10px", background: "#fafafa", borderRadius: 8 }}>
              <span style={{ fontSize: 11, color: "#999", fontWeight: 600 }}>今月の自腹高速 合計</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: "#e55" }}>¥{fmt(tollTotal)}</span>
            </div>
          </div>
        </div>}

        {visitedTabs.has("graph") && <div style={{ display: activeTab === "graph" ? "block" : "none" }}>
          {/* 給料推定カード */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={lbl}>給料推定</span>
              <div style={{ background: topRateTier && commissionRate >= topRateTier.rate ? "#F6BE00" : commissionRate > 0 ? "#FFF0A0" : "#f0f0f0", borderRadius: 99, padding: "3px 10px", fontSize: 13, fontWeight: 700, color: "#111" }}>{commissionRate}%歩合</div>
            </div>
            <div style={{ fontSize: 32, fontWeight: 800, marginBottom: 4 }}>¥{fmt(estimatedSalary)}</div>
            <div style={{ fontSize: 11, color: "#bbb", marginBottom: 12 }}>¥{fmt(total)} × {commissionRate}%</div>
            {sortedTiers.length === 0 ? (
              <div style={{ fontSize: 12, color: "#ccc" }}>設定タブで歩合率を設定してください</div>
            ) : (() => {
              const next = sortedTiers.find(t => total < (t.threshold || 0));
              if (!next) {
                return (
                  <div style={{ background: "#F6BE00", borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>🎉 最高{topRateTier.rate}%達成！</div>
                  </div>
                );
              }
              return (
                <div style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>次の {next.rate}% まであと（税込）</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>¥{fmt((next.threshold || 0) - total)}</div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>足切り（税込）¥{fmt(next.threshold || 0)}　達成時給料 ¥{fmt(Math.round((next.threshold || 0) * (next.rate || 0) / 100))}</div>
                </div>
              );
            })()}
          </div>

          {/* 足切り設定 */}
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 12 }}>足切り設定</div>
            <CommissionPanel commission={commission} saveCommission={saveCommission} />
          </div>

          {/* 最高歩合のための出勤日数設定 */}
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 12 }}>最高歩合の出勤条件</div>
            <AttendanceTablePanel commission={commission} periodAtt={periodAtt} saveAttendanceTable={saveAttendanceTable} />
          </div>
        </div>}

        {visitedTabs.has("calendar") && <div style={{ display: activeTab === "calendar" ? "block" : "none" }}> {/* 出番表 */}
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#aaa", lineHeight: 1.8 }}>
              タップするたびに切り替わります：<br />
              <span style={{ color: "#111", fontWeight: 700 }}>出勤</span>　→　<span style={{ color: "#4a90d9", fontWeight: 700 }}>有給</span>　→　<span style={{ color: "#e55", fontWeight: 700 }}>欠勤</span>　→　なし
            </p>
          </div>
          {(periodAtt.work > 0 || periodAtt.paid > 0 || periodAtt.absent > 0) && (
            <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#bbb", marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>今月の出勤状況</div>
              <div style={{ display: "flex", gap: 16 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800 }}>{periodAtt.work}</div><div style={{ fontSize: 10, color: "#999" }}>出勤</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#4a90d9" }}>{periodAtt.paid}</div><div style={{ fontSize: 10, color: "#999" }}>有給</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#e55" }}>{periodAtt.absent}</div><div style={{ fontSize: 10, color: "#999" }}>欠勤</div></div>
                {topRateTier && targetTop > 0 && <div style={{ marginLeft: "auto", textAlign: "right" }}><div style={{ fontSize: 11, color: "#bbb" }}>{topRateTier.rate}%足切り（税込）</div><div style={{ fontSize: 14, fontWeight: 700 }}>¥{fmt(targetTop)}</div></div>}
              </div>
            </div>
          )}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <button onClick={prevCal} style={navBtn}>‹</button>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 17, fontWeight: 700 }}>{calYear}年{calMonth + 1}月</div>
                <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>出勤{calWorkCount}日　有給{calPaidCount}日</div>
              </div>
              <button onClick={nextCal} style={navBtn}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 }}>
              {WEEKDAYS.map((w, i) => <div key={w} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, paddingBottom: 8, color: i===0?"#e55":i===6?"#55a":"#bbb" }}>{w}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
              {calCells.map((day, idx) => {
                if (!day) return <div key={`e-${idx}`} />;
                const isToday = calYear===today.year && calMonth===today.month && day===today.day;
                const state = getAttState(calYear, calMonth, day);
                const dow = (calFirst + day - 1) % 7;
                return <CalDay key={day} day={day} isToday={isToday} state={state} dow={dow} calYear={calYear} calMonth={calMonth} onToggle={toggleAtt} />;
              })}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16, paddingTop: 14, borderTop: "1px solid #f0f0f0", justifyContent: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, background: "#111", borderRadius: 5 }} />出勤</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, background: "#4a90d9", borderRadius: 5 }} />有給</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, background: "#e55", borderRadius: 5 }} />欠勤</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, border: "2px solid #999", borderRadius: 5 }} />今日</div>
            </div>
          </div>

          {/* 締日設定 */}
          <div style={{ ...card, padding: "10px 14px" }}>
            {!editingClosing ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: "#999", fontWeight: 600 }}>締日設定</div>
                  <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{closingLabel}</div>
                  {closingDay !== 0 && <div style={{ fontSize: 10, color: "#bbb", marginTop: 2 }}>{closingDay >= 29 ? `${closingDay}日（短い月は末日）が1期間の最終日` : `前月${closingDay+1}日〜今月${closingDay}日`}</div>}
                </div>
                <button onClick={() => setEditingClosing(true)} style={{ ...ghostBtn, padding: "8px 14px", flex: "none" }}>変更</button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 10, color: "#999", fontWeight: 600, marginBottom: 6 }}>締日設定</div>
                <div style={{ fontSize: 11, color: "#999", marginBottom: 8, lineHeight: 1.6 }}>1〜31を入力（末日締めは「0」）</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="number" placeholder="例：20" min={0} max={31} value={closingInput} onChange={e => setClosingInput(e.target.value)} style={{ ...inputStyle, padding: "8px 10px", boxSizing: "border-box", minWidth: 0 }} onKeyDown={e => e.key === "Enter" && saveClosing()} />
                  <span style={{ color: "#999", fontSize: 13 }}>日</span>
                  <button onClick={saveClosing} style={{ ...primaryBtn, padding: "8px 14px", flex: "none" }}>保存</button>
                  <button onClick={() => { setEditingClosing(false); setClosingInput(""); }} style={{ ...ghostBtn, padding: "8px 12px", flex: "none" }}>×</button>
                </div>
              </>
            )}
          </div>
        </div>}

        {visitedTabs.has("settings") && (
          <div style={{ display: activeTab === "settings" ? "block" : "none" }}>

            <div style={card}>
              <div style={{ ...lbl, marginBottom: 12 }}>設定リセット</div>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>
                締日・歩合率・出勤調整など、全ての設定値を消去します。売上記録には影響しません。
              </div>
              {!confirmingReset ? (
                <button onClick={() => setConfirmingReset(true)} style={{ background: "#e55", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "13px", width: "100%" }}>
                  全ての設定を削除
                </button>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: "#e55", fontWeight: 700, marginBottom: 8, textAlign: "center" }}>本当に削除しますか？</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => {
                      setData(p => ({ ...p, settings: { closingDay: 0, commission: { tiers: [], attendanceTable: [] } } }));
                      setConfirmingReset(false);
                    }} style={{ background: "#e55", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "13px", flex: 1 }}>削除する</button>
                    <button onClick={() => setConfirmingReset(false)} style={{ ...ghostBtn, flex: 1, padding: "13px" }}>キャンセル</button>
                  </div>
                </>
              )}
            </div>

            <div style={card}>
              <div style={{ ...lbl, marginBottom: 12 }}>クラウド同期 (GitHub Gist)</div>
              <GistSyncPanel pat={pat} gistId={gistId} status={syncStatus} setupSync={setupSync} disconnectSync={disconnectSync} manualSync={manualSync} />
            </div>

            <div style={card}>
              <div style={{ ...lbl, marginBottom: 12 }}>アプリ更新</div>
              <button onClick={async () => {
                try {
                  if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                  }
                  if (window.caches) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                  }
                } catch {}
                window.location.reload();
              }} style={{ ...primaryBtn, width: "100%", padding: "13px" }}>最新版に更新する</button>
              <div style={{ fontSize: 11, color: "#ccc", marginTop: 10, lineHeight: 1.7 }}>キャッシュとService Workerを破棄してから再読み込みします。</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AttendanceTablePanel({ commission, periodAtt, saveAttendanceTable }) {
  const baseTiers = sortTiers(commission?.tiers || []);
  const baseTop = baseTiers.length > 0 ? baseTiers[baseTiers.length - 1] : null;
  const stored = Array.isArray(commission?.attendanceTable) ? commission.attendanceTable : [];
  const [rows, setRows] = useState(stored);
  const [expanded, setExpanded] = useState(stored.length === 0);
  useEffect(() => { setRows(Array.isArray(commission?.attendanceTable) ? commission.attendanceTable : []); }, [commission?.attendanceTable]);
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const updateRow = (i, patch) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const removeRow = (i) => setRows(prev => prev.filter((_, idx) => idx !== i));
  const addRow = () => setRows(prev => [...prev, { work: periodAtt?.work || 0, paid: periodAtt?.paid || 0, absent: periodAtt?.absent || 0, target: 0 }]);
  const onSave = () => {
    const cleaned = rows.map(r => ({
      work: Math.max(0, Math.round(num(r.work))),
      paid: Math.max(0, Math.round(num(r.paid))),
      absent: Math.max(0, Math.round(num(r.absent))),
      target: Math.max(0, Math.round(num(r.target))),
    }));
    saveAttendanceTable(cleaned);
  };
  const dirty = JSON.stringify(rows) !== JSON.stringify(stored);
  if (!baseTop) {
    return <div style={{ fontSize: 12, color: "#ccc" }}>給料タブで歩合率を設定すると有効になります</div>;
  }
  const matched = rows.find(r => Number(r.work) === (periodAtt?.work || 0) && Number(r.paid) === (periodAtt?.paid || 0) && Number(r.absent) === (periodAtt?.absent || 0));
  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} style={{ width: "100%", textAlign: "left", background: "#f5f5f5", border: "none", borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{stored.length > 0 ? `${stored.length}件を設定済` : "未設定"}</div>
          <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{matched ? `今月は ¥${Number(matched.target).toLocaleString()} を適用中` : "今月に一致する行なし（基準値を使用）"}</div>
        </div>
        <span style={{ fontSize: 12, color: "#3399ff", fontWeight: 700 }}>編集 ▸</span>
      </button>
    );
  }
  return (
    <>
      <div style={{ fontSize: 11, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>
        出勤数・有休数・欠勤数の組み合わせごとに、最高歩合（{baseTop.rate}%）の足切り（税込）を入力できます。今月の出勤状況と一致した行があれば、その値が自動で反映されます。
      </div>
      {rows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.6fr 28px", gap: 4, fontSize: 10, color: "#999", padding: "0 4px", marginBottom: 4 }}>
          <div>出勤</div><div>有休</div><div>欠勤</div><div style={{ textAlign: "right" }}>足切り（税込・円）</div><div></div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.6fr 28px", gap: 4, alignItems: "center" }}>
            <input type="number" value={r.work} onChange={e => updateRow(i, { work: e.target.value })} style={{ ...inputStyle, padding: "8px 4px", boxSizing: "border-box", textAlign: "right", minWidth: 0, width: "100%" }} />
            <input type="number" value={r.paid} onChange={e => updateRow(i, { paid: e.target.value })} style={{ ...inputStyle, padding: "8px 4px", boxSizing: "border-box", textAlign: "right", minWidth: 0, width: "100%" }} />
            <input type="number" value={r.absent} onChange={e => updateRow(i, { absent: e.target.value })} style={{ ...inputStyle, padding: "8px 4px", boxSizing: "border-box", textAlign: "right", minWidth: 0, width: "100%" }} />
            <input type="number" value={r.target} onChange={e => updateRow(i, { target: e.target.value })} style={{ ...inputStyle, padding: "8px 6px", boxSizing: "border-box", textAlign: "right", minWidth: 0, width: "100%" }} />
            <button onClick={() => removeRow(i)} style={{ background: "transparent", border: "none", color: "#e55", fontSize: 18, cursor: "pointer", padding: 0 }}>✕</button>
          </div>
        ))}
      </div>
      <button onClick={addRow} style={{ ...ghostBtn, width: "100%", padding: "10px", marginBottom: 10 }}>+ 行を追加</button>
      <div style={{ padding: "10px 12px", background: matched ? "#FFF8E0" : "#f5f5f5", borderRadius: 8, marginBottom: 10, border: matched ? "1px solid #F6BE00" : "none" }}>
        <div style={{ fontSize: 10, color: "#999", marginBottom: 4 }}>今月（出勤{periodAtt?.work || 0}日 / 有休{periodAtt?.paid || 0}日 / 欠勤{periodAtt?.absent || 0}日）</div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          {matched ? `¥${Number(matched.target).toLocaleString()}（一致行を適用）` : `¥${(baseTop.threshold || 0).toLocaleString()}（一致行なし → 基準値）`}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => { onSave(); setExpanded(false); }} disabled={!dirty} style={{ ...primaryBtn, flex: 1, padding: "13px", opacity: dirty ? 1 : 0.4 }}>保存</button>
        <button onClick={() => { setRows(stored); setExpanded(false); }} style={{ ...ghostBtn, flex: 1, padding: "13px" }}>閉じる</button>
      </div>
      {(stored.length > 0 || rows.length > 0) && (
        <button onClick={() => { if (window.confirm("全ての行を消去します。よろしいですか？")) { setRows([]); saveAttendanceTable([]); } }} style={{ ...ghostBtn, width: "100%", padding: "10px", color: "#e55", borderColor: "#f5c8c8", fontSize: 12 }}>全て消去</button>
      )}
    </>
  );
}

function CommissionPanel({ commission, saveCommission }) {
  const initial = commission?.tiers?.length ? commission.tiers : [];
  const [tiers, setTiers] = useState(initial);
  const [expanded, setExpanded] = useState(initial.length === 0);
  useEffect(() => { setTiers(commission?.tiers || []); }, [commission?.tiers]);
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const updateRow = (i, patch) => setTiers(prev => prev.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  const removeRow = (i) => setTiers(prev => prev.filter((_, idx) => idx !== i));
  const addRow = () => setTiers(prev => [...prev, { threshold: 0, rate: 0 }]);
  const onSave = () => {
    const cleaned = tiers
      .map(t => ({ threshold: Math.max(0, Math.round(num(t.threshold))), rate: Math.max(0, Math.min(100, num(t.rate))) }))
      .sort((a, b) => a.threshold - b.threshold);
    saveCommission({ tiers: cleaned });
  };
  const dirty = JSON.stringify(tiers) !== JSON.stringify(commission?.tiers || []);
  const savedCount = commission?.tiers?.length || 0;
  const topSaved = savedCount > 0 ? sortTiers(commission.tiers)[savedCount - 1] : null;
  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)} style={{ width: "100%", textAlign: "left", background: "#f5f5f5", border: "none", borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{savedCount > 0 ? `${savedCount}段階を設定済` : "未設定"}</div>
          {topSaved && <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>最高 {topSaved.rate}% / 足切り ¥{(topSaved.threshold || 0).toLocaleString()}</div>}
        </div>
        <span style={{ fontSize: 12, color: "#3399ff", fontWeight: 700 }}>編集 ▸</span>
      </button>
    );
  }
  return (
    <>
      <div style={{ fontSize: 11, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>
        足切り（税込・円）と、その金額に達した時の歩合（%）を1行ずつ追加してください。<br />
        営収が足切り以上になると、対応する歩合に切り替わります。何段階でも作れます。
      </div>
      {tiers.length === 0 ? (
        <div style={{ fontSize: 12, color: "#ccc", textAlign: "center", padding: "16px 0" }}>歩合がまだ登録されていません</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 32px", gap: 6, fontSize: 10, color: "#999", padding: "0 4px" }}>
            <div>足切り（税込・円）</div>
            <div style={{ textAlign: "right" }}>歩合 (%)</div>
            <div></div>
          </div>
          {tiers.map((t, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 32px", gap: 6, alignItems: "center" }}>
              <input type="number" value={t.threshold} onChange={e => updateRow(i, { threshold: e.target.value })} style={{ ...inputStyle, padding: "8px 10px", boxSizing: "border-box" }} />
              <input type="number" step="0.01" value={t.rate} onChange={e => updateRow(i, { rate: e.target.value })} style={{ ...inputStyle, padding: "8px", boxSizing: "border-box", textAlign: "right" }} />
              <button onClick={() => removeRow(i)} style={{ background: "transparent", border: "none", color: "#e55", fontSize: 18, cursor: "pointer", padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <button onClick={addRow} style={{ ...ghostBtn, width: "100%", padding: "10px", marginBottom: 8 }}>+ 段階を追加</button>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => { onSave(); setExpanded(false); }} disabled={!dirty} style={{ ...primaryBtn, flex: 1, padding: "13px", opacity: dirty ? 1 : 0.4 }}>保存</button>
        <button onClick={() => { setTiers(commission?.tiers || []); setExpanded(false); }} style={{ ...ghostBtn, flex: 1, padding: "13px" }}>閉じる</button>
      </div>
      {(commission?.tiers?.length > 0 || tiers.length > 0) && (
        <button onClick={() => { if (window.confirm("全ての段階を消去します。よろしいですか？")) { setTiers([]); saveCommission({ tiers: [] }); } }} style={{ ...ghostBtn, width: "100%", padding: "10px", color: "#e55", borderColor: "#f5c8c8", fontSize: 12 }}>全て消去</button>
      )}
    </>
  );
}

function GistSyncPanel({ pat, gistId, status, setupSync, disconnectSync, manualSync }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const statusColor = status.kind === "error" ? "#e55" : status.kind === "ok" ? "#3399ff" : status.kind === "syncing" ? "#c8900a" : "#bbb";
  if (pat && gistId) {
    return (
      <>
        <div style={{ padding: "12px 14px", background: "#f5f5f5", borderRadius: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>同期中の Gist</div>
          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#333", wordBreak: "break-all" }}>{gistId}</div>
          <div style={{ fontSize: 11, color: statusColor, marginTop: 6, fontWeight: 600 }}>{status.msg || "待機中"}</div>
        </div>
        <button onClick={manualSync} style={{ ...primaryBtn, width: "100%", padding: "13px", marginBottom: 8 }}>今すぐ同期</button>
        <button onClick={disconnectSync} style={{ ...ghostBtn, width: "100%", padding: "13px", color: "#e55", borderColor: "#f5c8c8" }}>同期を解除</button>
        <div style={{ fontSize: 11, color: "#ccc", marginTop: 10, lineHeight: 1.7 }}>データ変更後 2 秒で自動的に Gist へ保存されます。別端末では同じ PAT を入力すると復元できます。</div>
      </>
    );
  }
  return (
    <>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>
        GitHub の Personal Access Token (gist スコープ) を一度だけ設定すれば、入力のたびに private gist へ自動バックアップされます。
        <br /><a href="https://github.com/settings/tokens/new?scopes=gist&description=Taxi+Sales+Management" target="_blank" rel="noopener" style={{ color: "#3399ff", textDecoration: "underline" }}>PAT 作成ページを開く</a>
      </div>
      <input
        type="password"
        placeholder="ghp_xxxxxxxxxxxxxxxx"
        value={input}
        onChange={e => setInput(e.target.value)}
        autoComplete="off"
        style={{ ...inputStyle, width: "100%", marginBottom: 8, boxSizing: "border-box" }}
      />
      <button
        disabled={busy || !input.trim()}
        onClick={async () => {
          setBusy(true);
          try { await setupSync(input.trim()); setInput(""); } catch {}
          finally { setBusy(false); }
        }}
        style={{ ...primaryBtn, width: "100%", padding: "13px", opacity: busy || !input.trim() ? 0.5 : 1 }}
      >
        {busy ? "設定中…" : "同期を有効にする"}
      </button>
      {status.msg && <div style={{ fontSize: 11, color: statusColor, marginTop: 8, fontWeight: 600 }}>{status.msg}</div>}
    </>
  );
}

const STATE_STYLE = {
  work:       { bg: "#111",    text: "#fff",  border: "none" },
  paid_leave: { bg: "#4a90d9", text: "#fff",  border: "none" },
  absent:     { bg: "#e55",    text: "#fff",  border: "none" },
};

const CalDay = memo(({ day, isToday, state, dow, calYear, calMonth, onToggle }) => {
  const s = STATE_STYLE[state];
  const bg = s ? s.bg : "transparent";
  const textColor = s ? s.text : isToday ? "#111" : dow===0 ? "#e55" : dow===6 ? "#55a" : "#333";
  const border = isToday
    ? "2.5px solid #999"
    : "2px solid transparent";
  return (
    <button onClick={() => onToggle(calYear, calMonth, day)} style={{ border, borderRadius: 9, padding: "7px 2px", cursor: "pointer", background: bg, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ fontSize: 14, lineHeight: 1, fontWeight: (state || isToday) ? 700 : 400, color: textColor }}>{day}</span>
    </button>
  );
});

const card = { background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, padding: "16px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.03)" };
const lbl = { fontSize: 10, color: "#bbb", letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase" };
const statBox = { background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" };
const statLbl = { fontSize: 11, color: "#bbb", marginBottom: 4 };
const statCard = { background: "#fff", border: "1px solid #ebebeb", borderRadius: 12, padding: "8px 10px", boxShadow: "0 1px 4px rgba(0,0,0,0.03)", display: "flex", flexDirection: "column", gap: 1 };
const statTitle = { fontSize: 10, color: "#999", fontWeight: 600 };
const statValue = { fontSize: 18, fontWeight: 800, color: "#111", lineHeight: 1.2, marginTop: 2 };
const statUnit = { fontSize: 11, fontWeight: 600, color: "#999", marginLeft: 2 };
const statSub = { fontSize: 10, color: "#bbb", marginTop: 2 };
const miniBtn = { background: "transparent", border: "1px solid #e5e5e5", borderRadius: 6, color: "#888", fontSize: 10, cursor: "pointer", padding: "2px 7px", lineHeight: 1.2 };
const inputStyle = { flex: 1, background: "#f5f5f5", border: "1.5px solid #ebebeb", borderRadius: 8, padding: "10px 12px", color: "#111", fontSize: 16, outline: "none" };
const primaryBtn = { background: "#111", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "10px 16px" };
const ghostBtn = { background: "transparent", border: "1.5px solid #e0e0e0", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer", padding: "6px 12px" };
const navBtn = { background: "none", border: "none", color: "#ccc", fontSize: 26, cursor: "pointer", padding: "0 8px" };
