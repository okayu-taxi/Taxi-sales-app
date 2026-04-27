import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense, memo } from "react";
import { subscribeAuth, signInWithGoogle, signUpWithEmail, signInWithEmail, resetPassword, signOutUser, pushToFirestore, pullFromFirestore } from "./firebaseSync";

const LazyChart = lazy(() => import("./SalesChart"));

const STORAGE_KEY = "taxi_sales_data_v3";

const DEFAULT_COMMISSION = {
  tiers: [], // [{ threshold: number, rate: number(%)}]
};

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
function estimateSalary(revenue, conf = DEFAULT_COMMISSION) {
  return Math.round(revenue * getCommissionRate(revenue, conf) / 100);
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

function authErrorMsg(e) {
  switch (e?.code) {
    case "auth/invalid-email": return "メールアドレスの形式が正しくありません";
    case "auth/missing-email": return "メールアドレスを入力してください";
    case "auth/missing-password": return "パスワードを入力してください";
    case "auth/weak-password": return "パスワードは6文字以上必要です";
    case "auth/email-already-in-use": return "このメールアドレスは既に登録されています";
    case "auth/user-not-found": return "アカウントが見つかりません";
    case "auth/wrong-password":
    case "auth/invalid-credential": return "メールアドレスまたはパスワードが違います";
    case "auth/too-many-requests": return "試行回数が多すぎます。しばらくしてからお試しください";
    case "auth/network-request-failed": return "ネットワークに接続できませんでした";
    case "auth/popup-blocked": return "ポップアップがブロックされました。設定をご確認ください";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return "サインインがキャンセルされました";
    default: return e?.message || "エラーが発生しました";
  }
}

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
    d.settings.commission = { tiers: [] };
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
  const [attMenu, setAttMenu] = useState(null);
  const swipeRef = useRef(null);
  const sliderRef = useRef(null);
  const trackRef = useRef(null);
  const calSwipeRef = useRef(null);
  const TABS = ["home", "calendar", "graph", "settings"];
  const activeIdx = TABS.indexOf(activeTab);
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
    let work = 0, paid = 0, absent = 0, dayOff = 0;
    datesInPeriod.forEach(d => {
      const v = attendance[`${d.year}-${d.month}-${d.day}`];
      if (v === 'work') work++;
      else if (v === 'paid_leave') paid++;
      else if (v === 'absent') absent++;
      else if (v === 'day_off') dayOff++;
    });
    return { work, paid, absent, dayOff };
  }, [datesInPeriod, attendance]);

  const commission = useMemo(() => ({ ...DEFAULT_COMMISSION, ...(data.settings?.commission || {}) }), [data.settings?.commission]);
  const sortedTiers = useMemo(() => sortTiers(commission.tiers), [commission]);
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

  // ── Firebase sync ──
  const [fbUser, setFbUser] = useState(null);
  const [fbStatus, setFbStatus] = useState({ kind: "idle", msg: "" });
  const [fbReady, setFbReady] = useState(false);
  const lastFbPushedRef = useRef(null);

  useEffect(() => {
    const unsub = subscribeAuth(async (user) => {
      setFbUser(user);
      if (!user) { setFbReady(false); lastFbPushedRef.current = null; return; }
      setFbStatus({ kind: "syncing", msg: "サーバから取得中…" });
      try {
        const remote = await pullFromFirestore(user.uid);
        const localRaw = localStorage.getItem(STORAGE_KEY);
        const local = localRaw ? JSON.parse(localRaw) : null;
        const localEmpty = !local || ((Object.keys(local.periods || {}).length === 0) && (Object.keys(local.attendance || {}).length === 0));
        if (remote?.data && localEmpty) {
          const migrated = migrateData(remote.data);
          setData(migrated);
          lastFbPushedRef.current = JSON.stringify(migrated);
          setFbStatus({ kind: "ok", msg: "サーバから復元しました" });
        } else {
          lastFbPushedRef.current = JSON.stringify(local);
          setFbStatus({ kind: "ok", msg: `同期済 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` });
        }
      } catch (e) {
        setFbStatus({ kind: "error", msg: `取得失敗: ${e.message}` });
      } finally {
        setFbReady(true);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!fbUser || !fbReady) return;
    if (isFirstSaveRef.current) return;
    const json = JSON.stringify(data);
    if (lastFbPushedRef.current === json) return;
    const t = setTimeout(async () => {
      setFbStatus({ kind: "syncing", msg: "同期中…" });
      try {
        await pushToFirestore(fbUser.uid, data);
        lastFbPushedRef.current = json;
        setFbStatus({ kind: "ok", msg: `同期済 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` });
      } catch (e) {
        setFbStatus({ kind: "error", msg: `同期失敗: ${e.message}` });
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [data, fbUser, fbReady]);

  const fbSignIn = useCallback(async () => {
    setFbStatus({ kind: "syncing", msg: "サインイン中…" });
    try {
      await signInWithGoogle();
    } catch (e) {
      if (e?.code === "auth/popup-closed-by-user" || e?.code === "auth/cancelled-popup-request") {
        setFbStatus({ kind: "idle", msg: "" });
        return;
      }
      setFbStatus({ kind: "error", msg: `サインイン失敗: ${authErrorMsg(e)}` });
    }
  }, []);
  const fbSignInEmail = useCallback(async (email, password) => {
    setFbStatus({ kind: "syncing", msg: "サインイン中…" });
    try {
      await signInWithEmail(email, password);
    } catch (e) {
      setFbStatus({ kind: "error", msg: authErrorMsg(e) });
      throw e;
    }
  }, []);
  const fbSignUpEmail = useCallback(async (email, password) => {
    setFbStatus({ kind: "syncing", msg: "アカウント作成中…" });
    try {
      await signUpWithEmail(email, password);
    } catch (e) {
      setFbStatus({ kind: "error", msg: authErrorMsg(e) });
      throw e;
    }
  }, []);
  const fbResetPassword = useCallback(async (email) => {
    try {
      await resetPassword(email);
    } catch (e) {
      throw new Error(authErrorMsg(e));
    }
  }, []);
  const fbSignOut = useCallback(async () => {
    if (!window.confirm("サインアウトします。サーバ上のデータは残ります。")) return;
    try { await signOutUser(); } catch {}
  }, []);

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

  const toggleAtt = useCallback((y, m, d) => {
    setAttMenu({ y, m, d });
  }, []);

  const setAttState = useCallback((y, m, d, state) => {
    const key = `${y}-${m}-${d}`;
    setData(p => {
      const na = { ...p.attendance };
      if (state) na[key] = state;
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
  const initialDaily = goal > 0 && periodAtt.work > 0 ? Math.ceil(goal / periodAtt.work) : 0;
  const paceColor = (initialDaily > 0 && remaining > 0)
    ? (dailyNeeded > initialDaily ? "#e55" : dailyNeeded < initialDaily ? "#3399ff" : "#333")
    : "#333";
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
  const calTrackRef = useRef(null);
  const calContainerRef = useRef(null);
  const calSettleTimerRef = useRef(null);

  const prevCal = useCallback(() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m => m - 1); }, [calMonth]);
  const nextCal = useCallback(() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); } else setCalMonth(m => m + 1); }, [calMonth]);

  const onCalTouchStart = useCallback((e) => {
    e.stopPropagation();
    if (calSettleTimerRef.current) return;
    const t = e.touches[0];
    const w = calContainerRef.current?.clientWidth || 0;
    calSwipeRef.current = { x: t.clientX, y: t.clientY, dragging: false, w };
  }, []);
  const onCalTouchMove = useCallback((e) => {
    const s = calSwipeRef.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.dragging) {
      if (Math.abs(dy) > 6) {
        calSwipeRef.current = null;
        return;
      }
      if (Math.abs(dx) < 12) return;
      s.dragging = true;
      if (calTrackRef.current) calTrackRef.current.style.transition = "none";
    }
    e.stopPropagation();
    if (calTrackRef.current && s.w > 0) {
      calTrackRef.current.style.transform = `translate3d(${-s.w + dx}px, 0, 0)`;
    }
  }, []);
  const onCalTouchEnd = useCallback((e) => {
    const s = calSwipeRef.current;
    if (!s) return;
    calSwipeRef.current = null;
    const track = calTrackRef.current;
    if (track) track.style.transition = "transform 0.25s ease-out";
    if (!s.dragging) return;
    e.stopPropagation();
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const w = s.w || calContainerRef.current?.clientWidth || 1;
    const threshold = w * 0.2;
    let dir = 0;
    if (dx < -threshold) dir = 1;
    else if (dx > threshold) dir = -1;
    if (track) {
      track.style.transform = `translate3d(${-w - dir * w}px, 0, 0)`;
    }
    if (dir !== 0) {
      calSettleTimerRef.current = window.setTimeout(() => {
        calSettleTimerRef.current = null;
        if (calTrackRef.current) {
          calTrackRef.current.style.transition = "none";
          calTrackRef.current.style.transform = `translate3d(${-w}px, 0, 0)`;
        }
        if (dir > 0) nextCal(); else prevCal();
      }, 250);
    }
  }, [prevCal, nextCal]);

  const fmt = (n) => n.toLocaleString("ja-JP");
  const closingLabel = closingDay === 0 ? "末日締め" : `毎月${closingDay}日締め`;

  const calMonths = useMemo(() => {
    const monthMeta = (y, m) => {
      const days = getDaysInMonth(y, m);
      const first = getFirstDayOfWeek(y, m);
      const cells = [...Array(first).fill(null), ...Array.from({length: days}, (_, i) => i + 1)];
      let work = 0, paid = 0;
      for (let d = 1; d <= days; d++) {
        const v = attendance[`${y}-${m}-${d}`];
        if (v === 'work') work++;
        else if (v === 'paid_leave') paid++;
      }
      return { y, m, days, first, cells, work, paid };
    };
    const prev = calMonth === 0 ? { y: calYear - 1, m: 11 } : { y: calYear, m: calMonth - 1 };
    const next = calMonth === 11 ? { y: calYear + 1, m: 0 } : { y: calYear, m: calMonth + 1 };
    return [monthMeta(prev.y, prev.m), monthMeta(calYear, calMonth), monthMeta(next.y, next.m)];
  }, [calYear, calMonth, attendance]);
  const { cells: calCells, first: calFirst } = calMonths[1];

  return (
    <div style={{ height: "100vh", background: "#f7f7f7", color: "#111", fontFamily: "'Noto Sans JP', -apple-system, sans-serif", maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column" }}>

      <div style={{ background: "#fff", padding: "8px 16px 6px", borderBottom: "1px solid #ebebeb", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={prevPeriod} style={navBtn}>‹</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: closingDay === 0 ? 17 : 13, fontWeight: 700, color: "#111", lineHeight: 1.2 }}>{period.label}</div>
            <div style={{ fontSize: 10, color: "#ccc" }}>{closingLabel}</div>
          </div>
          <button onClick={nextPeriod} style={navBtn}>›</button>
        </div>
        {fbUser && (
          <div style={{ position: "absolute", right: 8, top: 4, fontSize: 9, color: fbStatus.kind === "error" ? "#e55" : fbStatus.kind === "syncing" ? "#c8900a" : "#3399ff", fontWeight: 600 }}>
            {fbStatus.kind === "syncing" ? "⟳" : fbStatus.kind === "error" ? "⚠" : "☁︎"}
          </div>
        )}
      </div>

      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #ebebeb" }}>
        {[["home","ホーム"],["calendar","出番表"],["graph","歩合率設定"],["settings","システム設定"]].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ flex: 1, padding: "7px 0", border: "none", background: "none", color: activeTab === key ? "#111" : "#ccc", fontWeight: activeTab === key ? 700 : 400, fontSize: 11, cursor: "pointer", borderBottom: activeTab === key ? "2px solid #111" : "2px solid transparent", transition: "all 0.15s" }}>{label}</button>
        ))}
      </div>

      <div
        ref={sliderRef}
        style={{ flex: 1, overflow: "hidden", position: "relative" }}
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
          swipeRef.current = { x: t.clientX, y: t.clientY, dragging: false, w: sliderRef.current?.clientWidth || 0 };
        }}
        onTouchMove={(e) => {
          const s = swipeRef.current;
          if (!s) return;
          const t = e.touches[0];
          const dx = t.clientX - s.x;
          const dy = t.clientY - s.y;
          if (!s.dragging) {
            if (Math.abs(dy) > 6) { swipeRef.current = null; return; }
            if (Math.abs(dx) < 12) return;
            s.dragging = true;
            if (trackRef.current) trackRef.current.style.transition = "none";
          }
          let drag = dx;
          if (activeIdx === 0 && drag > 0) drag *= 0.3;
          if (activeIdx === TABS.length - 1 && drag < 0) drag *= 0.3;
          if (trackRef.current && s.w > 0) {
            trackRef.current.style.transform = `translate3d(${-activeIdx * s.w + drag}px, 0, 0)`;
          }
        }}
        onTouchEnd={(e) => {
          const s = swipeRef.current;
          if (!s) return;
          swipeRef.current = null;
          if (trackRef.current) trackRef.current.style.transition = "transform 0.25s ease-out";
          if (!s.dragging) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - s.x;
          const w = s.w || sliderRef.current?.clientWidth || 1;
          const threshold = w * 0.2;
          let next = activeIdx;
          if (dx < -threshold && activeIdx < TABS.length - 1) next = activeIdx + 1;
          else if (dx > threshold && activeIdx > 0) next = activeIdx - 1;
          if (trackRef.current) trackRef.current.style.transform = `translate3d(${-next * w}px, 0, 0)`;
          if (next !== activeIdx) setActiveTab(TABS[next]);
        }}
      >
        <div ref={trackRef} style={{ display: "flex", width: `${TABS.length * 100}%`, height: "100%", transform: `translate3d(-${activeIdx * (100 / TABS.length)}%, 0, 0)`, transition: "transform 0.25s ease-out", willChange: "transform" }}>

        <div style={{ ...tabPanelStyle, order: 1 }}>{visitedTabs.has("home") && <>

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
              <div style={{ fontSize: 14, fontWeight: 700, color: paceColor }}>¥{fmt(dailyNeeded)}</div>
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
        </>}</div>

        <div style={{ ...tabPanelStyle, order: 3 }}>{visitedTabs.has("graph") && <>
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
                  <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>次の {next.rate}% まであと</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>¥{fmt((next.threshold || 0) - total)}</div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>足切り ¥{fmt(next.threshold || 0)}　達成時給料 ¥{fmt(Math.round((next.threshold || 0) * (next.rate || 0) / 100))}</div>
                </div>
              );
            })()}
          </div>

          {/* 足切り設定 */}
          <div style={card}>
            <CommissionPanel commission={commission} saveCommission={saveCommission} />
          </div>
        </>}</div>

        <div style={{ ...tabPanelStyle, order: 2 }}>{visitedTabs.has("calendar") && <> {/* 出番表 */}
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#bbb", marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>今月の出番日数</div>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#111" }}>{periodAtt.work}</div><div style={{ fontSize: 10, color: "#999" }}>出番</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#c8900a" }}>{periodAtt.absent}</div><div style={{ fontSize: 10, color: "#999" }}>公出</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#3399ff" }}>{periodAtt.paid}</div><div style={{ fontSize: 10, color: "#999" }}>有給</div></div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#e55" }}>{periodAtt.dayOff}</div><div style={{ fontSize: 10, color: "#999" }}>休み</div></div>
            </div>
          </div>
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4, fontWeight: 700, letterSpacing: 1 }}>締日</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{closingLabel}</div>
              </div>
              <button onClick={() => { setClosingInput(String(closingDay)); setEditingClosing(true); }} style={{ ...ghostBtn, padding: "6px 14px", fontSize: 12, flexShrink: 0 }}>変更</button>
            </div>
          </div>
          <div style={card} onTouchStart={onCalTouchStart} onTouchMove={onCalTouchMove} onTouchEnd={onCalTouchEnd}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <button onClick={prevCal} style={navBtn}>‹</button>
              <div style={{ textAlign: "center" }}>
                {(() => {
                  const onToday = calYear === today.year && calMonth === today.month;
                  return (
                    <button
                      onClick={() => { if (!onToday) { setCalYear(today.year); setCalMonth(today.month); } }}
                      disabled={onToday}
                      style={{ background: "none", border: "none", padding: 0, cursor: onToday ? "default" : "pointer", color: "#111", fontSize: 17, fontWeight: 700, textDecoration: onToday ? "none" : "underline", textDecorationStyle: "dotted", textDecorationColor: "#bbb", textUnderlineOffset: 3, fontFamily: "inherit" }}
                    >
                      {calYear}年{calMonth + 1}月
                    </button>
                  );
                })()}
              </div>
              <button onClick={nextCal} style={navBtn}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 }}>
              {WEEKDAYS.map((w, i) => <div key={w} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, paddingBottom: 8, color: i===0?"#e55":i===6?"#55a":"#bbb" }}>{w}</div>)}
            </div>
            <div ref={calContainerRef} style={{ overflow: "hidden", position: "relative" }}>
              <div ref={calTrackRef} style={{ display: "flex", transform: "translate3d(-100%, 0, 0)", transition: "transform 0.25s ease-out", willChange: "transform" }}>
                {calMonths.map((mo) => (
                  <div key={`${mo.y}-${mo.m}`} style={{ flex: "0 0 100%", display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
                    {mo.cells.map((day, idx) => {
                      if (!day) return <div key={`e-${idx}`} />;
                      const isToday = mo.y===today.year && mo.m===today.month && day===today.day;
                      const state = getAttState(mo.y, mo.m, day);
                      const dow = (mo.first + day - 1) % 7;
                      return <CalDay key={day} day={day} isToday={isToday} state={state} dow={dow} calYear={mo.y} calMonth={mo.m} onToggle={toggleAtt} />;
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#aaa", lineHeight: 1.8 }}>
              日付をタップして<span style={{ color: "#111", fontWeight: 700 }}>出番</span>・<span style={{ color: "#c8900a", fontWeight: 700 }}>公出</span>・<span style={{ color: "#3399ff", fontWeight: 700 }}>有給</span>・<span style={{ color: "#e55", fontWeight: 700 }}>休み</span>を選択
            </p>
          </div>
        </>}</div>

        <div style={{ ...tabPanelStyle, order: 4 }}>{visitedTabs.has("settings") && (
          <>

            <div style={card}>
              <div style={{ ...lbl, marginBottom: 12 }}>設定リセット</div>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>
                締日・歩合率など、全ての設定値を消去します。売上記録には影響しません。
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
                      setData(p => ({ ...p, settings: { closingDay: 0, commission: { tiers: [] } } }));
                      setConfirmingReset(false);
                    }} style={{ background: "#e55", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "13px", flex: 1 }}>削除する</button>
                    <button onClick={() => setConfirmingReset(false)} style={{ ...ghostBtn, flex: 1, padding: "13px" }}>キャンセル</button>
                  </div>
                </>
              )}
            </div>

            <div style={card}>
              <div style={{ ...lbl, marginBottom: 12 }}>ログイン</div>
              <FirebaseSyncPanel user={fbUser} status={fbStatus} signInGoogle={fbSignIn} signUpEmail={fbSignUpEmail} signInEmail={fbSignInEmail} resetPassword={fbResetPassword} signOut={fbSignOut} />
            </div>

            <div style={card}>
              <div style={{ ...lbl, marginBottom: 12 }}>再読み込み</div>
              <div style={{ fontSize: 12, color: "#999", marginBottom: 10, lineHeight: 1.7 }}>動作がおかしい時・データが反映されない時に押してください。</div>
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
              }} style={{ ...primaryBtn, width: "100%", padding: "13px" }}>再読み込みする</button>
            </div>
          </>
        )}</div>
        </div>
      </div>
      {attMenu && (
        <AttMenuSheet
          y={attMenu.y}
          m={attMenu.m}
          d={attMenu.d}
          current={getAttState(attMenu.y, attMenu.m, attMenu.d)}
          onSelect={(state) => { setAttState(attMenu.y, attMenu.m, attMenu.d, state); setAttMenu(null); }}
          onClose={() => setAttMenu(null)}
        />
      )}
      {editingClosing && (
        <ClosingSheet
          value={closingInput}
          onChange={setClosingInput}
          onSave={saveClosing}
          onClose={() => { setEditingClosing(false); setClosingInput(""); }}
        />
      )}
    </div>
  );
}


function CommissionPanel({ commission, saveCommission }) {
  const tiers = sortTiers(commission?.tiers || []);
  const [expanded, setExpanded] = useState(tiers.length === 0);
  const [editingTier, setEditingTier] = useState(null);
  const savedCount = tiers.length;
  const topSaved = savedCount > 0 ? tiers[savedCount - 1] : null;

  const upsertTier = (idx, t) => {
    const next = [...tiers];
    if (idx >= 0) next[idx] = t; else next.push(t);
    saveCommission({ tiers: sortTiers(next) });
    setEditingTier(null);
  };
  const deleteTier = (idx) => {
    const next = tiers.filter((_, i) => i !== idx);
    saveCommission({ tiers: next });
    setEditingTier(null);
  };

  if (!expanded) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={lbl}>足切り設定</div>
          <button onClick={() => setExpanded(true)} style={{ ...ghostBtn, padding: "6px 14px", fontSize: 12 }}>編集</button>
        </div>
        <div style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{savedCount > 0 ? `${savedCount}段階を設定済` : "未設定"}</div>
          {topSaved && <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>最高 {topSaved.rate}% / 足切り ¥{(topSaved.threshold || 0).toLocaleString()}</div>}
        </div>
      </>
    );
  }
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={lbl}>足切り設定</div>
        <button onClick={() => setExpanded(false)} style={{ ...ghostBtn, padding: "6px 14px", fontSize: 12 }}>閉じる</button>
      </div>
      <div style={{ fontSize: 11, color: "#999", marginBottom: 10, lineHeight: 1.5 }}>
        段階をタップで編集、+ で追加。営収がその足切り以上で対応する歩合に切替。
      </div>
      {tiers.length === 0 ? (
        <div style={{ fontSize: 12, color: "#ccc", textAlign: "center", padding: "16px 0" }}>段階がまだ登録されていません</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {tiers.map((t, i) => {
            const next = tiers[i + 1];
            const startStr = `¥${(t.threshold || 0).toLocaleString()}`;
            const endStr = next ? `¥${Math.max(0, (next.threshold || 0) - 1).toLocaleString()}` : "上限なし";
            return (
              <button
                key={i}
                onClick={() => setEditingTier({ idx: i, tier: t })}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f5f5f5", border: "1px solid #ebebeb", borderRadius: 10, padding: "10px 14px", cursor: "pointer", textAlign: "left", color: "inherit", width: "100%" }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{startStr} 〜 {endStr}</div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#111", flexShrink: 0, marginLeft: 12 }}>{t.rate}<span style={{ fontSize: 12, fontWeight: 600, color: "#999", marginLeft: 1 }}>%</span></div>
              </button>
            );
          })}
        </div>
      )}
      <button onClick={() => setEditingTier({ idx: -1, tier: null })} style={{ ...ghostBtn, width: "100%", padding: "10px", marginBottom: 6 }}>+ 段階を追加</button>
      {tiers.length > 0 && (
        <button onClick={() => { if (window.confirm("全ての段階を消去します。よろしいですか？")) { saveCommission({ tiers: [] }); } }} style={{ ...ghostBtn, width: "100%", padding: "8px", color: "#e55", borderColor: "#f5c8c8", fontSize: 12 }}>全て消去</button>
      )}
      {editingTier && (
        <CommissionTierSheet
          tier={editingTier.tier}
          onSave={(t) => upsertTier(editingTier.idx, t)}
          onDelete={editingTier.idx >= 0 ? () => deleteTier(editingTier.idx) : null}
          onClose={() => setEditingTier(null)}
        />
      )}
    </>
  );
}

function FirebaseSyncPanel({ user, status, signInGoogle, signUpEmail, signInEmail, resetPassword, signOut }) {
  const statusColor = status.kind === "error" ? "#e55" : status.kind === "ok" ? "#3399ff" : status.kind === "syncing" ? "#c8900a" : "#bbb";
  if (user) {
    const name = user.displayName || user.email || user.uid.slice(0, 12);
    return (
      <>
        <div style={{ padding: "12px 14px", background: "#f5f5f5", borderRadius: 10, marginBottom: 10, display: "flex", alignItems: "center", gap: 12 }}>
          {user.photoURL && (
            <img src={user.photoURL} alt="" referrerPolicy="no-referrer" style={{ width: 40, height: 40, borderRadius: "50%", flexShrink: 0 }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 11, color: "#bbb", marginBottom: 2 }}>サインイン中</div>
            <div style={{ fontSize: 13, color: "#333", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
            {user.email && user.email !== name && (
              <div style={{ fontSize: 11, color: "#999", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
            )}
            <div style={{ fontSize: 11, color: statusColor, marginTop: 4, fontWeight: 600 }}>{status.msg || "待機中"}</div>
          </div>
        </div>
        <button onClick={signOut} style={{ ...ghostBtn, width: "100%", padding: "13px", color: "#e55", borderColor: "#f5c8c8" }}>サインアウト</button>
      </>
    );
  }
  return (
    <SignedOutPanel status={status} signInGoogle={signInGoogle} signUpEmail={signUpEmail} signInEmail={signInEmail} resetPassword={resetPassword} statusColor={statusColor} />
  );
}

function SignedOutPanel({ status, signInGoogle, signUpEmail, signInEmail, resetPassword, statusColor }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState("");

  const submit = async (e) => {
    e?.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setResetMsg("");
    try {
      if (mode === "signup") await signUpEmail(email.trim(), password);
      else await signInEmail(email.trim(), password);
      setEmail(""); setPassword("");
    } catch {} finally { setBusy(false); }
  };
  const handleReset = async () => {
    if (!email.trim()) { setResetMsg("メールアドレスを入力してから押してください"); return; }
    setBusy(true);
    try {
      await resetPassword(email.trim());
      setResetMsg(`${email.trim()} に再設定メールを送信しました`);
    } catch (e) {
      setResetMsg(e.message || "送信に失敗しました");
    } finally { setBusy(false); }
  };

  return (
    <>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 12, lineHeight: 1.7 }}>
        ログインすると、入力データが自動的にクラウドへバックアップされます。再インストールや機種変更でも同じアカウントでログインすれば復元できます。
      </div>

      <form onSubmit={submit}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="メールアドレス"
          value={email}
          onChange={e => setEmail(e.target.value)}
          style={{ ...inputStyle, width: "100%", marginBottom: 8, boxSizing: "border-box" }}
        />
        <input
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder={mode === "signup" ? "パスワード（6文字以上）" : "パスワード"}
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={{ ...inputStyle, width: "100%", marginBottom: 8, boxSizing: "border-box" }}
        />
        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          style={{ ...primaryBtn, width: "100%", padding: "13px", opacity: busy || !email.trim() || !password ? 0.5 : 1 }}
        >
          {busy ? "処理中…" : (mode === "signup" ? "新規登録する" : "ログイン")}
        </button>
      </form>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 12 }}>
        <button onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setResetMsg(""); }} style={{ background: "none", border: "none", color: "#3399ff", cursor: "pointer", padding: 0, fontSize: 12 }}>
          {mode === "signup" ? "ログインに戻る" : "新規登録"}
        </button>
        {mode === "signin" && (
          <button onClick={handleReset} disabled={busy} style={{ background: "none", border: "none", color: "#999", cursor: "pointer", padding: 0, fontSize: 12 }}>
            パスワードを忘れた場合
          </button>
        )}
      </div>

      {resetMsg && <div style={{ fontSize: 11, color: "#3399ff", marginTop: 8, lineHeight: 1.6 }}>{resetMsg}</div>}
      {status.msg && <div style={{ fontSize: 11, color: statusColor, marginTop: 8, fontWeight: 600 }}>{status.msg}</div>}

      <div style={{ display: "flex", alignItems: "center", margin: "16px 0", color: "#ccc", fontSize: 11 }}>
        <div style={{ flex: 1, height: 1, background: "#ebebeb" }} />
        <div style={{ padding: "0 10px" }}>または</div>
        <div style={{ flex: 1, height: 1, background: "#ebebeb" }} />
      </div>

      <button onClick={signInGoogle} style={{ width: "100%", padding: "12px", background: "#fff", border: "1px solid #dadce0", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 14, fontWeight: 500, color: "#3c4043" }}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
          <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
          <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/>
          <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"/>
        </svg>
        Google でログイン
      </button>
    </>
  );
}

const STATE_LABEL = { work: "出番", paid_leave: "有給", absent: "公出", day_off: "休み" };
const STATE_COLOR = { work: "#111", paid_leave: "#3399ff", absent: "#c8900a", day_off: "#e55" };
const TODAY_COLOR = "#111";

const CalDay = memo(({ day, isToday, state, dow, calYear, calMonth, onToggle }) => {
  const numColor = isToday ? "#fff" : dow === 0 ? "#e55" : dow === 6 ? "#55a" : "#333";
  return (
    <button
      onClick={() => onToggle(calYear, calMonth, day)}
      style={{ border: "none", padding: "4px 0", cursor: "pointer", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}
    >
      <span style={{ width: 26, height: 26, lineHeight: "26px", borderRadius: "50%", background: isToday ? TODAY_COLOR : "transparent", color: numColor, fontWeight: 700, textAlign: "center", fontSize: 14 }}>{day}</span>
      <span style={{ fontSize: 9, fontWeight: 700, lineHeight: 1, minHeight: 9, color: state ? STATE_COLOR[state] : "transparent" }}>{state ? STATE_LABEL[state] : "・"}</span>
    </button>
  );
});

const ATT_OPTIONS = [
  { key: "work", label: "出番", color: "#111" },
  { key: "absent", label: "公出", color: "#c8900a" },
  { key: "paid_leave", label: "有給", color: "#3399ff" },
  { key: "day_off", label: "休み", color: "#e55" },
  { key: null, label: "なし", color: "#999" },
];

function ClosingSheet({ value, onChange, onSave, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 480, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: "20px 16px 24px", boxSizing: "border-box" }}>
        <div style={{ fontSize: 14, color: "#999", textAlign: "center", marginBottom: 8, fontWeight: 600 }}>締日設定</div>
        <div style={{ fontSize: 11, color: "#999", marginBottom: 12, lineHeight: 1.6, textAlign: "center" }}>1〜31を入力（末日締めは「0」）</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input
            type="number"
            placeholder="例：20"
            min={0}
            max={31}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => e.key === "Enter" && onSave()}
            style={{ ...inputStyle, padding: "12px 14px", boxSizing: "border-box", minWidth: 0, fontSize: 16 }}
          />
          <span style={{ color: "#999", fontSize: 14 }}>日</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={onSave} style={{ ...primaryBtn, padding: "14px", width: "100%" }}>保存</button>
          <button onClick={onClose} style={{ padding: "12px 16px", border: "none", borderRadius: 10, background: "#f5f5f5", fontSize: 13, color: "#888", cursor: "pointer" }}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

function CommissionTierSheet({ tier, onSave, onDelete, onClose }) {
  const [threshold, setThreshold] = useState(tier?.threshold != null ? String(tier.threshold) : "");
  const [rate, setRate] = useState(tier?.rate != null ? String(tier.rate) : "");
  const [error, setError] = useState("");
  const isEdit = !!tier;
  const submit = () => {
    const t = parseInt(threshold, 10);
    const r = parseFloat(rate);
    if (isNaN(t) || t < 0) { setError("足切りには 0 以上の整数を入力してください"); return; }
    if (isNaN(r) || r < 0 || r > 100) { setError("歩合は 0〜100 の数値を入力してください"); return; }
    onSave({ threshold: Math.round(t), rate: r });
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 480, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: "20px 16px 24px", boxSizing: "border-box" }}>
        <div style={{ fontSize: 14, color: "#999", textAlign: "center", marginBottom: 16, fontWeight: 600 }}>{isEdit ? "段階を編集" : "新しい段階を追加"}</div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>足切り（円）</div>
          <input type="number" inputMode="numeric" placeholder="例: 500000" value={threshold} onChange={e => setThreshold(e.target.value)} style={{ ...inputStyle, width: "100%", padding: "12px 14px", boxSizing: "border-box", fontSize: 16 }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>歩合（%）</div>
          <input type="number" inputMode="decimal" step="0.1" placeholder="例: 55" value={rate} onChange={e => setRate(e.target.value)} style={{ ...inputStyle, width: "100%", padding: "12px 14px", boxSizing: "border-box", fontSize: 16 }} />
        </div>
        {error && <div style={{ fontSize: 11, color: "#e55", marginBottom: 10 }}>{error}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={submit} style={{ ...primaryBtn, padding: "14px", width: "100%" }}>保存</button>
          {onDelete && <button onClick={() => { if (window.confirm("この段階を削除します。よろしいですか？")) onDelete(); }} style={{ ...ghostBtn, padding: "12px", width: "100%", color: "#e55", borderColor: "#f5c8c8" }}>削除</button>}
          <button onClick={onClose} style={{ padding: "12px 16px", border: "none", borderRadius: 10, background: "#f5f5f5", fontSize: 13, color: "#888", cursor: "pointer" }}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

function AttMenuSheet({ y, m, d, current, onSelect, onClose }) {
  const w = ["日","月","火","水","木","金","土"][new Date(y, m, d).getDay()];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 480, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: "20px 16px 24px", boxSizing: "border-box" }}>
        <div style={{ fontSize: 14, color: "#999", textAlign: "center", marginBottom: 16, fontWeight: 600 }}>{y}年{m + 1}月{d}日（{w}）</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ATT_OPTIONS.map(it => {
            const isSel = current === it.key;
            return (
              <button
                key={String(it.key)}
                onClick={() => onSelect(it.key)}
                style={{ padding: "14px 16px", border: isSel ? `2px solid ${it.color}` : "1px solid #ebebeb", borderRadius: 10, background: isSel ? `${it.color}10` : "#fff", fontSize: 15, fontWeight: 700, color: it.color, cursor: "pointer", textAlign: "center" }}
              >
                {it.label}
              </button>
            );
          })}
          <button onClick={onClose} style={{ padding: "12px 16px", border: "none", borderRadius: 10, background: "#f5f5f5", fontSize: 13, color: "#888", cursor: "pointer", marginTop: 4 }}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

const card = { background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, padding: "16px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.03)" };
const lbl = { fontSize: 10, color: "#bbb", letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase" };
const statCard = { background: "#fff", border: "1px solid #ebebeb", borderRadius: 12, padding: "8px 10px", boxShadow: "0 1px 4px rgba(0,0,0,0.03)", display: "flex", flexDirection: "column", gap: 1 };
const statTitle = { fontSize: 10, color: "#999", fontWeight: 600 };
const statValue = { fontSize: 18, fontWeight: 800, color: "#111", lineHeight: 1.2, marginTop: 2 };
const statSub = { fontSize: 10, color: "#bbb", marginTop: 2 };
const miniBtn = { background: "transparent", border: "1px solid #e5e5e5", borderRadius: 6, color: "#888", fontSize: 10, cursor: "pointer", padding: "2px 7px", lineHeight: 1.2 };
const inputStyle = { flex: 1, background: "#f5f5f5", border: "1.5px solid #ebebeb", borderRadius: 8, padding: "10px 12px", color: "#111", fontSize: 16, outline: "none" };
const primaryBtn = { background: "#111", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "10px 16px" };
const ghostBtn = { background: "transparent", border: "1.5px solid #e0e0e0", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer", padding: "6px 12px" };
const navBtn = { background: "none", border: "none", color: "#ccc", fontSize: 26, cursor: "pointer", padding: "0 8px" };
const tabPanelStyle = { flex: "0 0 25%", width: "25%", height: "100%", overflowY: "auto", padding: "10px 12px 40px", boxSizing: "border-box" };
