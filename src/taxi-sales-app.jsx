import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense, memo } from "react";
import { getPat, setPat, getGistId, setGistId, validatePat, findExistingGist, createGist, pushToGist, pullFromGist } from "./gistSync";

const LazyChart = lazy(() => import("./SalesChart"));

const STORAGE_KEY = "taxi_sales_data_v3";

// 61%歩合達成に必要な営収テーブル（key: 出勤数_有給数）
const TARGET_61 = {
  "24_0": 627110,
  "23_1": 633200, "23_0": 638660,
  "22_2": 639320, "22_1": 644770, "22_0": 650230,
  "21_3": 645440, "21_2": 650890, "21_1": 656340, "21_0": 661800,
  "20_4": 651550, "20_3": 657000, "20_2": 662460, "20_1": 667910, "20_0": 673370,
};

const STEP_UP = 584091; // 56.74%基準営収（税抜）

function getCommissionRate(revenue, t61) {
  if (!t61) {
    // t61不明時：STEP_UPを境にステップ関数（参考値）
    if (revenue >= STEP_UP) return 56.74;
    return 50;
  }
  // (STEP_UP, 56.74%) と (t61, 61%) を通る一次関数
  const slope = (61 - 56.74) / (t61 - STEP_UP);
  const rate = 56.74 + slope * (revenue - STEP_UP);
  return Math.max(50, Math.min(61, parseFloat(rate.toFixed(2))));
}
function calc50Threshold(t61) {
  if (!t61) return null;
  const slope = (61 - 56.74) / (t61 - STEP_UP);
  return Math.round(STEP_UP - 6.74 / slope);
}
function toTaxInc(amount) {
  return Math.ceil(amount * 1.1 / 10) * 10;
}
function estimateSalary(revenue, t61) {
  return Math.round(revenue * getCommissionRate(revenue, t61) / 100);
}
function lookup61(work, paid) {
  return TARGET_61[`${work}_${paid}`] ?? null;
}

function getDaysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
function getFirstDayOfWeek(year, month) { return new Date(year, month, 1).getDay(); }
function getPeriod(year, month, closingDay) {
  if (closingDay === 0) return { startYear: year, startMonth: month, startDay: 1, endYear: year, endMonth: month, endDay: getDaysInMonth(year, month), label: `${year}年${month + 1}月` };
  let sm = month - 1, sy = year;
  if (sm < 0) { sm = 11; sy = year - 1; }
  return { startYear: sy, startMonth: sm, startDay: closingDay + 1, endYear: year, endMonth: month, endDay: closingDay, label: `${sy}年${sm + 1}月${closingDay + 1}日〜${year}年${month + 1}月${closingDay}日` };
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
  if (closingDay > 0 && n.day > closingDay) {
    return { year: n.month === 11 ? n.year + 1 : n.year, month: (n.month + 1) % 12 };
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
  if (!d) return { settings: { closingDay: 0 }, periods: {}, attendance: {} };
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
  const [goalInput, setGoalInput] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [editingClosing, setEditingClosing] = useState(false);
  const [closingInput, setClosingInput] = useState("");

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

  const target61 = useMemo(() => lookup61(periodAtt.work, periodAtt.paid), [periodAtt.work, periodAtt.paid]);

  useEffect(() => {
    const tin = datesInPeriod.find(d => d.year === today.year && d.month === today.month && d.day === today.day);
    const def = tin || datesInPeriod[0];
    if (def) setInputDateKey(`${def.year}-${def.month}-${def.day}`);
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

  // Pull-to-refresh (ref-driven, no React re-renders during drag)
  const appRef = useRef(null);
  const indicatorRef = useRef(null);

  useEffect(() => {
    const THRESHOLD = 70;
    let startY = null;
    let curY = 0;
    let raf = null;
    let refreshing = false;

    const apply = () => {
      raf = null;
      const app = appRef.current;
      const ind = indicatorRef.current;
      if (app) app.style.transform = `translate3d(0, ${curY}px, 0)`;
      if (ind) {
        if (curY > 0 || refreshing) {
          ind.style.display = "block";
          ind.style.opacity = String(Math.min(1, curY / 50));
          ind.style.transform = `translate3d(-50%, ${Math.min(curY - 30, 30)}px, 0)`;
          ind.textContent = refreshing ? "更新中…" : curY > THRESHOLD ? "離して更新" : "下に引いて更新";
        } else {
          ind.style.display = "none";
        }
      }
    };

    const schedule = () => { if (raf == null) raf = requestAnimationFrame(apply); };

    const reset = (animated) => {
      curY = 0;
      const app = appRef.current;
      if (app) {
        if (animated) {
          app.style.transition = "transform 0.2s";
          app.style.transform = "translate3d(0, 0, 0)";
          setTimeout(() => { if (app) app.style.transition = ""; }, 220);
        } else {
          app.style.transform = "translate3d(0, 0, 0)";
        }
      }
      const ind = indicatorRef.current;
      if (ind) ind.style.display = "none";
    };

    const onStart = (e) => {
      if (refreshing || window.scrollY > 0) { startY = null; return; }
      startY = e.touches[0].clientY;
      curY = 0;
      const app = appRef.current;
      if (app) app.style.transition = "";
    };
    const onMove = (e) => {
      if (startY == null) return;
      if (window.scrollY > 0) { startY = null; reset(false); return; }
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) {
        curY = Math.min(140, dy * 0.5);
        schedule();
      }
    };
    const onEnd = () => {
      if (startY == null) return;
      startY = null;
      if (curY > THRESHOLD) {
        refreshing = true;
        curY = 60;
        schedule();
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.getRegistrations()
            .then(regs => Promise.all(regs.map(r => r.update())))
            .finally(() => window.location.reload());
        } else {
          window.location.reload();
        }
      } else {
        reset(true);
      }
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      if (raf) cancelAnimationFrame(raf);
    };
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
    const cur = pData.days[inputDateKey];
    const next = cur ? { ...cur, toll: t } : { toll: t };
    updPeriod({ ...pData, days: { ...pData.days, [inputDateKey]: next } });
    setInputToll("");
  }, [inputToll, inputDateKey, pData, updPeriod]);
  const saveGoal = useCallback(() => { const g = parseInt(goalInput.replace(/,/g, "")); if (!g || isNaN(g)) return; updPeriod({ ...pData, goal: g }); setGoalInput(""); setEditingGoal(false); }, [goalInput, pData, updPeriod]);
  const autoSetGoal61 = useCallback(() => {
    if (!target61) return;
    const newGoal = toTaxInc(target61);
    setData(p => ({
      ...p,
      periods: {
        ...p.periods,
        [pKey]: { ...(p.periods?.[pKey] || { days: {} }), goal: newGoal }
      }
    }));
  }, [target61, pKey]);
  const deleteDay = useCallback((key) => { const nd = { ...pData.days }; delete nd[key]; updPeriod({ ...pData, days: nd }); }, [pData, updPeriod]);
  const saveClosing = useCallback(() => { const v = parseInt(closingInput); if (isNaN(v) || v < 0 || v > 28) return; setData(p => ({ ...p, settings: { ...p.settings, closingDay: v } })); setClosingInput(""); setEditingClosing(false); }, [closingInput]);

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
  const commissionRate = useMemo(() => getCommissionRate(total, target61), [total, target61]);
  const estimatedSalary = useMemo(() => estimateSalary(total, target61), [total, target61]);
  const rate50 = useMemo(() => calc50Threshold(target61), [target61]);

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
      const dow = WEEKDAYS[new Date(d.year, d.month, d.day).getDay()];
      return { label: `${d.day}(${dow})`, 売上: sales && sales > 0 ? sales : null, dateKey: key };
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
    setInputToll(existing?.toll ? String(existing.toll) : "");
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
    <div ref={appRef} style={{ minHeight: "100vh", background: "#f7f7f7", color: "#111", fontFamily: "'Noto Sans JP', -apple-system, sans-serif", maxWidth: 480, margin: "0 auto", paddingBottom: 80, willChange: "transform" }}>

      <div ref={indicatorRef} style={{ position: "fixed", top: 0, left: "50%", transform: "translate3d(-50%, -30px, 0)", opacity: 0, pointerEvents: "none", zIndex: 100, padding: "8px 16px", background: "#fff", border: "1px solid #ebebeb", borderRadius: 99, boxShadow: "0 2px 8px rgba(0,0,0,0.08)", fontSize: 12, color: "#666", fontWeight: 600, display: "none", willChange: "transform, opacity" }} />

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
        {[["home","ホーム"],["calendar","出番表"],["graph","給料"],["settings","設定"]].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ flex: 1, padding: "7px 0", border: "none", background: "none", color: activeTab === key ? "#111" : "#ccc", fontWeight: activeTab === key ? 700 : 400, fontSize: 11, cursor: "pointer", borderBottom: activeTab === key ? "2px solid #111" : "2px solid transparent", transition: "all 0.15s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "10px 12px" }}>

        {activeTab === "home" && <>

          {/* 2x2 統計グリッド */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div style={statCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={statTitle}>今月の目標</span>
                <button onClick={() => { setEditingGoal(!editingGoal); setGoalInput(""); }} style={miniBtn}>{editingGoal ? "×" : "編集"}</button>
              </div>
              {editingGoal ? (
                <>
                  <input type="number" placeholder="目標額" value={goalInput} onChange={e => setGoalInput(e.target.value)} style={{ ...inputStyle, fontSize: 13, padding: "6px 8px", marginTop: 4 }} onKeyDown={e => e.key === "Enter" && saveGoal()} />
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <button onClick={saveGoal} style={{ ...primaryBtn, flex: 1, padding: "5px", fontSize: 12 }}>保存</button>
                    {target61 && <button onClick={autoSetGoal61} style={{ ...ghostBtn, flex: 1, padding: "5px", fontSize: 11, color: "#c8900a", borderColor: "#F6BE00" }}>61%自動</button>}
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
              <select value={inputDateKey} onChange={e => { setInputDateKey(e.target.value); const v = pData.days[e.target.value]; setInputAmount(v?.sales != null ? String(v.sales) : ""); setInputToll(v?.toll ? String(v.toll) : ""); }} style={{ ...inputStyle, width: 116, flex: "none", padding: "8px", fontSize: 13, boxSizing: "border-box" }}>
                {datesInPeriod.map(d => { const k = `${d.year}-${d.month}-${d.day}`; const w = WEEKDAYS[new Date(d.year, d.month, d.day).getDay()]; return <option key={k} value={k}>{d.month+1}月{d.day}日({w})</option>; })}
              </select>
              <input type="number" placeholder="売上（円）" value={inputAmount} onChange={e => setInputAmount(e.target.value)} style={{ ...inputStyle, padding: "8px 10px", minWidth: 0, boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && saveSales()} />
              <button onClick={saveSales} style={{ ...primaryBtn, padding: "8px 14px", flex: "none", whiteSpace: "nowrap" }}>{pData.days[inputDateKey]?.sales ? "更新" : "記録"}</button>
              {pData.days[inputDateKey] != null && (
                <button onClick={() => { deleteDay(inputDateKey); setInputAmount(""); setInputToll(""); }} style={{ ...ghostBtn, padding: "8px 10px", color: "#e55", borderColor: "#f5c8c8", flex: "none", whiteSpace: "nowrap" }}>削除</button>
              )}
            </div>
          </div>

          {/* 自腹高速入力カード */}
          <div style={{ ...card, padding: "10px 12px", marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ ...lbl, fontSize: 9 }}>自腹高速を入力</span>
              <span style={{ fontSize: 10, color: "#bbb" }}>
                {(() => { const [y,m,d] = inputDateKey.split("-").map(Number); if (!y) return ""; const w = WEEKDAYS[new Date(y, m, d).getDay()]; return `${m+1}月${d}日(${w})`; })()}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "stretch", marginBottom: 8 }}>
              <input type="number" placeholder="自腹高速（円）" value={inputToll} onChange={e => setInputToll(e.target.value)} style={{ ...inputStyle, padding: "8px 10px", minWidth: 0, boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && saveToll()} />
              <button onClick={saveToll} style={{ ...primaryBtn, padding: "8px 14px", flex: "none", whiteSpace: "nowrap" }}>{pData.days[inputDateKey]?.toll ? "更新" : "記録"}</button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 10px", background: "#fafafa", borderRadius: 8 }}>
              <span style={{ fontSize: 11, color: "#999", fontWeight: 600 }}>今期の自腹高速 合計</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: "#e55" }}>¥{fmt(tollTotal)}</span>
            </div>
          </div>
        </>}

        {activeTab === "graph" && <>
          {/* 給料推定カード */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={lbl}>給料推定</span>
              <div style={{ background: commissionRate >= 61 ? "#F6BE00" : commissionRate > 56.74 ? "#FFF0A0" : "#f0f0f0", borderRadius: 99, padding: "3px 10px", fontSize: 13, fontWeight: 700, color: "#111" }}>{commissionRate}%歩合</div>
            </div>
            <div style={{ fontSize: 32, fontWeight: 800, marginBottom: 4 }}>¥{fmt(estimatedSalary)}</div>
            <div style={{ fontSize: 11, color: "#bbb", marginBottom: 12 }}>¥{fmt(total)} × {commissionRate}%</div>
            {target61 ? (
              total >= target61 ? (
                <div style={{ background: "#F6BE00", borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>🎉 61%達成！</div>
                </div>
              ) : total >= STEP_UP ? (
                <div style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>61%達成まであと（税込）</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>¥{fmt(toTaxInc(target61 - total))}</div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>目標（税込）¥{fmt(toTaxInc(target61))}　達成時給料 ¥{fmt(Math.round(target61 * 0.61))}</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>56.74%まであと（税込）</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>¥{fmt(toTaxInc(STEP_UP - total))}</div>
                    <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>基準営収（税込）¥{fmt(toTaxInc(STEP_UP))}</div>
                  </div>
                  <div style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>61%まであと（税込）</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>¥{fmt(toTaxInc(target61 - total))}</div>
                    <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>目標（税込）¥{fmt(toTaxInc(target61))}　達成時給料 ¥{fmt(Math.round(target61 * 0.61))}</div>
                  </div>
                </div>
              )
            ) : (
              <div style={{ fontSize: 12, color: "#ccc" }}>出番表で出勤・有給を登録すると61%目標が表示されます</div>
            )}
          </div>

          {/* 歩合率のしくみ */}
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 4 }}>歩合率のしくみ</div>
            <div style={{ fontSize: 11, color: "#ccc", marginBottom: 12 }}>営収に応じて50〜61%の間で線形に変動</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rate50 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#f5f5f5", borderRadius: 10 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#aaa" }}>50%保証ライン（税込）</div>
                    <div style={{ fontSize: 12, color: "#bbb" }}>¥{fmt(toTaxInc(rate50))}以上で50%</div>
                  </div>
                  <span style={{ fontSize: 16, fontWeight: 800 }}>50%</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#f5f5f5", borderRadius: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#aaa" }}>基準（税込）</div>
                  <div style={{ fontSize: 12, color: "#bbb" }}>¥{fmt(toTaxInc(STEP_UP))}</div>
                </div>
                <span style={{ fontSize: 16, fontWeight: 800 }}>56.74%</span>
              </div>
              {target61 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#FFF8E0", borderRadius: 10, border: "1px solid #F6BE00" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#aaa" }}>61%目標（税込）・出勤{periodAtt.work}日有給{periodAtt.paid}日</div>
                    <div style={{ fontSize: 12, color: "#bbb" }}>¥{fmt(toTaxInc(target61))}</div>
                  </div>
                  <span style={{ fontSize: 16, fontWeight: 800, color: "#c8900a" }}>61%</span>
                </div>
              )}
            </div>
          </div>
        </>}

        {activeTab === "calendar" && <> {/* 出番表 */}
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#aaa", lineHeight: 1.8 }}>
              タップするたびに切り替わります：<br />
              <span style={{ color: "#111", fontWeight: 700 }}>出勤</span>　→　<span style={{ color: "#4a90d9", fontWeight: 700 }}>有給</span>　→　<span style={{ color: "#e55", fontWeight: 700 }}>欠勤</span>　→　なし
            </p>
          </div>
          {(periodAtt.work > 0 || periodAtt.paid > 0 || periodAtt.absent > 0) && (
            <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#bbb", marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>今期の出勤状況</div>
              <div style={{ display: "flex", gap: 16 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800 }}>{periodAtt.work}</div><div style={{ fontSize: 10, color: "#999" }}>出勤</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#4a90d9" }}>{periodAtt.paid}</div><div style={{ fontSize: 10, color: "#999" }}>有給</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#e55" }}>{periodAtt.absent}</div><div style={{ fontSize: 10, color: "#999" }}>欠勤</div></div>
                {target61 && <div style={{ marginLeft: "auto", textAlign: "right" }}><div style={{ fontSize: 11, color: "#bbb" }}>61%目標営収（税込）</div><div style={{ fontSize: 14, fontWeight: 700 }}>¥{fmt(toTaxInc(target61))}</div></div>}
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
        </>}

        {activeTab === "settings" && (
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 16 }}>締日設定</div>
            <div style={{ padding: "14px", background: "#f5f5f5", borderRadius: 10, marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>現在の設定</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{closingLabel}</div>
              {closingDay !== 0 && <div style={{ fontSize: 12, color: "#bbb", marginTop: 6 }}>前月{closingDay+1}日〜今月{closingDay}日が1期間</div>}
            </div>
            {!editingClosing ? (
              <button onClick={() => setEditingClosing(true)} style={{ ...primaryBtn, width: "100%", padding: "13px" }}>締日を変更する</button>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>締日を入力（1〜28）<br /><span style={{ color: "#ccc" }}>末日締めは「0」を入力</span></div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                  <input type="number" placeholder="例：20" min={0} max={28} value={closingInput} onChange={e => setClosingInput(e.target.value)} style={inputStyle} onKeyDown={e => e.key === "Enter" && saveClosing()} />
                  <span style={{ color: "#999", fontSize: 14 }}>日</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={saveClosing} style={{ ...primaryBtn, flex: 1, padding: "13px" }}>保存</button>
                  <button onClick={() => { setEditingClosing(false); setClosingInput(""); }} style={{ ...ghostBtn, flex: 1, padding: "13px" }}>キャンセル</button>
                </div>
              </>
            )}
            <div style={{ marginTop: 20 }}>
              <div style={{ ...lbl, marginBottom: 12 }}>クラウド同期 (GitHub Gist)</div>
              <GistSyncPanel pat={pat} gistId={gistId} status={syncStatus} setupSync={setupSync} disconnectSync={disconnectSync} manualSync={manualSync} />
            </div>
            <div style={{ marginTop: 20 }}>
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
const inputStyle = { flex: 1, background: "#f5f5f5", border: "1.5px solid #ebebeb", borderRadius: 8, padding: "10px 12px", color: "#111", fontSize: 15, outline: "none" };
const primaryBtn = { background: "#111", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "10px 16px" };
const ghostBtn = { background: "transparent", border: "1.5px solid #e0e0e0", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer", padding: "6px 12px" };
const navBtn = { background: "none", border: "none", color: "#ccc", fontSize: 26, cursor: "pointer", padding: "0 8px" };
