import { useState, useEffect, useMemo, useCallback, lazy, Suspense, memo } from "react";

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

const STEP_UP = 584091;

function getCommissionRate(revenue, t61) {
  if (t61 && revenue >= t61) return 61;
  if (revenue >= STEP_UP) return 56.74;
  return 50;
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
  return d;
}

export default function TaxiSalesApp() {
  const [curYear, setCurYear] = useState(() => getCorrectPeriod(readClosingDay()).year);
  const [curMonth, setCurMonth] = useState(() => getCorrectPeriod(readClosingDay()).month);
  const [calYear, setCalYear] = useState(today.year);
  const [calMonth, setCalMonth] = useState(today.month);
  const [activeTab, setActiveTab] = useState("home");
  const [inputAmount, setInputAmount] = useState("");
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

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} }, [data]);

  useEffect(() => {
    const onPageShow = () => {
      const { year, month } = getCorrectPeriod(readClosingDay());
      setCurYear(year); setCurMonth(month);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const updPeriod = useCallback((np) => setData(p => ({ ...p, periods: { ...p.periods, [pKey]: np } })), [pKey]);
  const saveDay = useCallback(() => { const a = parseInt(inputAmount.replace(/,/g, "")); if (!a || isNaN(a)) return; updPeriod({ ...pData, days: { ...pData.days, [inputDateKey]: a } }); setInputAmount(""); }, [inputAmount, inputDateKey, pData, updPeriod]);
  const saveGoal = useCallback(() => { const g = parseInt(goalInput.replace(/,/g, "")); if (!g || isNaN(g)) return; updPeriod({ ...pData, goal: g }); setGoalInput(""); setEditingGoal(false); }, [goalInput, pData, updPeriod]);
  const autoSetGoal61 = useCallback(() => {
    if (!target61) return;
    const newGoal = Math.round(target61 * 1.1);
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

  const exportData = useCallback(() => {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `taxi-sales-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const importData = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed.settings || !parsed.periods) { alert("ファイルが正しくありません"); return; }
        setData(migrateData(parsed));
        alert("インポートしました");
      } catch { alert("ファイルの読み込みに失敗しました"); }
    };
    reader.readAsText(file);
    e.target.value = "";
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

  const total = useMemo(() => Object.values(pData.days).reduce((a, b) => a + b, 0), [pData.days]);
  const goal = pData.goal || 0;
  const remaining = Math.max(0, goal - total);
  const commissionRate = useMemo(() => getCommissionRate(total, target61), [total, target61]);
  const estimatedSalary = useMemo(() => estimateSalary(total, target61), [total, target61]);

  const { daysLeft, totalDays } = useMemo(() => {
    const idx = datesInPeriod.findIndex(d => d.year === today.year && d.month === today.month && d.day === today.day);
    return { daysLeft: idx === -1 ? 0 : datesInPeriod.length - idx, totalDays: datesInPeriod.length };
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
    let cum = 0;
    return datesInPeriod.map((d, i) => {
      cum += pData.days[`${d.year}-${d.month}-${d.day}`] || 0;
      return { label: `${d.month + 1}/${d.day}`, 累計売上: cum, 目標ライン: goal > 0 ? Math.round((goal / totalDays) * (i + 1)) : null };
    });
  }, [datesInPeriod, pData.days, goal, totalDays]);

  const prevPeriod = useCallback(() => { if (curMonth === 0) { setCurMonth(11); setCurYear(y => y - 1); } else setCurMonth(m => m - 1); }, [curMonth]);
  const nextPeriod = useCallback(() => { if (curMonth === 11) { setCurMonth(0); setCurYear(y => y + 1); } else setCurMonth(m => m + 1); }, [curMonth]);
  const prevCal = useCallback(() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m => m - 1); }, [calMonth]);
  const nextCal = useCallback(() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); } else setCalMonth(m => m + 1); }, [calMonth]);

  const fmt = (n) => n.toLocaleString("ja-JP");
  const sortedKeys = useMemo(() => Object.keys(pData.days).sort((a, b) => { const p = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m,d); }; return p(a)-p(b); }), [pData.days]);
  const fmtKey = (k) => { const [,m,d] = k.split("-").map(Number); return `${m+1}月${d}日`; };
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

      <div style={{ background: "#fff", padding: "18px 20px 14px", borderBottom: "1px solid #ebebeb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={prevPeriod} style={navBtn}>‹</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#bbb", letterSpacing: 3, marginBottom: 3 }}>TAXI SALES</div>
            <div style={{ fontSize: closingDay === 0 ? 20 : 14, fontWeight: 700, color: "#111", lineHeight: 1.3 }}>{period.label}</div>
            <div style={{ fontSize: 11, color: "#ccc", marginTop: 2 }}>{closingLabel}</div>
          </div>
          <button onClick={nextPeriod} style={navBtn}>›</button>
        </div>
      </div>

      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #ebebeb" }}>
        {[["home","ホーム"],["history","履歴"],["calendar","出番表"],["graph","給料"],["settings","設定"]].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ flex: 1, padding: "11px 0", border: "none", background: "none", color: activeTab === key ? "#111" : "#ccc", fontWeight: activeTab === key ? 700 : 400, fontSize: 11, cursor: "pointer", borderBottom: activeTab === key ? "2px solid #111" : "2px solid transparent", transition: "all 0.15s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "16px" }}>

        {activeTab === "home" && <>

          {/* 売上入力カード */}
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 12 }}>売上を入力</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <select value={inputDateKey} onChange={e => setInputDateKey(e.target.value)} style={{ ...inputStyle, width: 90, flex: "none" }}>
                {datesInPeriod.map(d => { const k = `${d.year}-${d.month}-${d.day}`; return <option key={k} value={k}>{d.month+1}/{d.day}</option>; })}
              </select>
              <input type="number" placeholder="金額（円）" value={inputAmount} onChange={e => setInputAmount(e.target.value)} style={inputStyle} onKeyDown={e => e.key === "Enter" && saveDay()} />
            </div>
            <button onClick={saveDay} style={{ ...primaryBtn, width: "100%", padding: "13px" }}>記録する</button>
          </div>

          {/* 期間目標カード */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={lbl}>期間目標（営収）</span>
              <div style={{ display: "flex", gap: 6 }}>
                {target61 && !editingGoal && (
                  <button onClick={autoSetGoal61} style={{ ...ghostBtn, fontSize: 11, color: "#c8900a", borderColor: "#F6BE00" }}>61%自動設定</button>
                )}
                <button onClick={() => { setEditingGoal(!editingGoal); setGoalInput(""); }} style={ghostBtn}>{editingGoal ? "キャンセル" : "手動設定"}</button>
              </div>
            </div>
            {editingGoal ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input type="number" placeholder="目標額を入力" value={goalInput} onChange={e => setGoalInput(e.target.value)} style={inputStyle} onKeyDown={e => e.key === "Enter" && saveGoal()} />
                <button onClick={saveGoal} style={primaryBtn}>保存</button>
              </div>
            ) : <div style={{ fontSize: 34, fontWeight: 800 }}>¥{fmt(goal)}</div>}
          </div>

          {/* 期間売上カード */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={lbl}>期間売上</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>{pct}%</span>
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, marginBottom: 12 }}>¥{fmt(total)}</div>
            <div style={{ background: "#ebebeb", borderRadius: 99, height: 7, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "#111", borderRadius: 99, transition: "width 0.5s" }} />
            </div>
            {goal > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={statBox}><div style={statLbl}>残り目標額</div><div style={{ fontSize: 17, fontWeight: 700 }}>¥{fmt(remaining)}</div></div>
                <div style={statBox}><div style={statLbl}>{hasAtt ? "残り出勤日" : "締日まで"}</div><div style={{ fontSize: 17, fontWeight: 700 }}>{hasAtt ? attLeft : daysLeft}日</div></div>
                {remaining > 0 && effLeft > 0 && (
                  <div style={{ gridColumn: "1/-1", background: "#111", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{hasAtt ? "残り出勤日あたりの必要売上" : "1日あたり必要な売上"}</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: "#fff" }}>¥{fmt(dailyNeeded)}<span style={{ fontSize: 13, fontWeight: 400, marginLeft: 4, color: "#777" }}>/ 日</span></div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>{hasAtt ? `出勤予定${attLeft}日で達成するには` : `残り${daysLeft}日で達成するには`}</div>
                  </div>
                )}
                {remaining === 0 && <div style={{ gridColumn: "1/-1", ...statBox, textAlign: "center" }}><span style={{ fontSize: 20, fontWeight: 800 }}>🎉 目標達成！</span></div>}
              </div>
            )}
          </div>
        </>}

        {activeTab === "graph" && <>
          {/* 給料推定カード */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={lbl}>給料推定</span>
              <div style={{ background: commissionRate === 61 ? "#F6BE00" : commissionRate === 56.74 ? "#e8e8e8" : "#f0f0f0", borderRadius: 99, padding: "3px 10px", fontSize: 13, fontWeight: 700, color: "#111" }}>{commissionRate}%歩合</div>
            </div>
            <div style={{ fontSize: 32, fontWeight: 800, marginBottom: 4 }}>¥{fmt(estimatedSalary)}</div>
            <div style={{ fontSize: 11, color: "#bbb", marginBottom: 12 }}>¥{fmt(total)} × {commissionRate}%</div>
            {target61 ? (
              total >= target61 ? (
                <div style={{ background: "#F6BE00", borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>🎉 61%達成！</div>
                </div>
              ) : (
                <div style={{ background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>61%達成まであと（税込）</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>¥{fmt(Math.round((target61 - total) * 1.1))}</div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>61%目標営収（税込）：¥{fmt(Math.round(target61 * 1.1))}　推定給料：¥{fmt(Math.round(target61 * 1.1 * 0.61))}</div>
                </div>
              )
            ) : (
              <div style={{ fontSize: 12, color: "#ccc" }}>出番表で出勤・有給を登録すると61%目標が表示されます</div>
            )}
          </div>

          {/* 歩合率のしくみ */}
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 12 }}>歩合率のしくみ</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#f5f5f5", borderRadius: 10 }}>
                <span style={{ fontSize: 13, color: "#aaa" }}>¥{fmt(STEP_UP)}未満</span>
                <span style={{ fontSize: 16, fontWeight: 800 }}>50%</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#f5f5f5", borderRadius: 10 }}>
                <span style={{ fontSize: 13, color: "#aaa" }}>¥{fmt(STEP_UP)}以上</span>
                <span style={{ fontSize: 16, fontWeight: 800 }}>56.74%</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#FFF8E0", borderRadius: 10, border: "1px solid #F6BE00" }}>
                <span style={{ fontSize: 13, color: "#aaa" }}>61%目標営収以上</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#c8900a" }}>61%</span>
              </div>
            </div>
            {target61 && (
              <div style={{ marginTop: 12, padding: "12px 14px", background: "#f5f5f5", borderRadius: 10 }}>
                <div style={{ fontSize: 11, color: "#bbb", marginBottom: 4 }}>今期の61%目標営収（税込）</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>¥{fmt(Math.round(target61 * 1.1))}</div>
                <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>出勤{periodAtt.work}日・有給{periodAtt.paid}日</div>
              </div>
            )}
          </div>
        </>}

        {activeTab === "calendar" && <> {/* 出番表 */}
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#aaa", lineHeight: 1.8 }}>
              タップするたびに切り替わります：<br />
              <span style={{ color: "#111", fontWeight: 700 }}>出勤</span>　→　<span style={{ color: "#c8900a", fontWeight: 700 }}>有給</span>　→　<span style={{ color: "#e55", fontWeight: 700 }}>欠勤</span>　→　なし
            </p>
          </div>
          {(periodAtt.work > 0 || periodAtt.paid > 0 || periodAtt.absent > 0) && (
            <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#bbb", marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>今期の出勤状況</div>
              <div style={{ display: "flex", gap: 16 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800 }}>{periodAtt.work}</div><div style={{ fontSize: 10, color: "#999" }}>出勤</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#c8900a" }}>{periodAtt.paid}</div><div style={{ fontSize: 10, color: "#999" }}>有給</div></div>
                <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 800, color: "#e55" }}>{periodAtt.absent}</div><div style={{ fontSize: 10, color: "#999" }}>欠勤</div></div>
                {target61 && <div style={{ marginLeft: "auto", textAlign: "right" }}><div style={{ fontSize: 11, color: "#bbb" }}>61%目標営収（税込）</div><div style={{ fontSize: 14, fontWeight: 700 }}>¥{fmt(Math.round(target61 * 1.1))}</div></div>}
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
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, background: "#F6BE00", borderRadius: 5 }} />有給</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, background: "#e55", borderRadius: 5 }} />欠勤</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#999" }}><div style={{ width: 18, height: 18, border: "2px solid #111", borderRadius: 5 }} />今日</div>
            </div>
          </div>
        </>}

        {activeTab === "history" && (
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 12 }}>日別記録</div>
            {sortedKeys.length === 0 ? (
              <div style={{ textAlign: "center", color: "#ccc", padding: "40px 0" }}>まだデータがありません</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sortedKeys.map(key => (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", background: "#fafafa", borderRadius: 9, border: "1px solid #f0f0f0" }}>
                    <span style={{ fontSize: 14, color: "#999" }}>{fmtKey(key)}</span>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>¥{fmt(pData.days[key])}</span>
                    <button onClick={() => deleteDay(key)} style={{ background: "none", border: "none", color: "#ddd", cursor: "pointer", fontSize: 16, padding: "0 4px" }}>✕</button>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", background: "#111", borderRadius: 9, marginTop: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#888" }}>合計</span>
                  <span style={{ fontSize: 18, fontWeight: 800, color: "#fff" }}>¥{fmt(total)}</span>
                </div>
              </div>
            )}
          </div>
        )}

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
              <div style={{ ...lbl, marginBottom: 12 }}>バックアップ</div>
              <button onClick={exportData} style={{ ...primaryBtn, width: "100%", padding: "13px", marginBottom: 10 }}>データをエクスポート（保存）</button>
              <label style={{ display: "block", textAlign: "center", background: "transparent", border: "1.5px solid #e0e0e0", borderRadius: 8, color: "#888", fontSize: 14, fontWeight: 700, cursor: "pointer", padding: "13px" }}>
                データをインポート（復元）
                <input type="file" accept=".json" onChange={importData} style={{ display: "none" }} />
              </label>
              <div style={{ fontSize: 11, color: "#ccc", marginTop: 10, lineHeight: 1.7 }}>PWAを再インストールする前にエクスポートしておくとデータが消えません。</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const STATE_STYLE = {
  work:       { bg: "#111",    text: "#fff",  border: "none" },
  paid_leave: { bg: "#F6BE00", text: "#333",  border: "none" },
  absent:     { bg: "#e55",    text: "#fff",  border: "none" },
};

const CalDay = memo(({ day, isToday, state, dow, calYear, calMonth, onToggle }) => {
  const s = STATE_STYLE[state];
  const bg = s ? s.bg : "transparent";
  const textColor = s ? s.text : isToday ? "#111" : dow===0 ? "#e55" : dow===6 ? "#55a" : "#333";
  const border = s ? "none" : isToday ? "2px solid #111" : "2px solid transparent";
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
const inputStyle = { flex: 1, background: "#f5f5f5", border: "1.5px solid #ebebeb", borderRadius: 8, padding: "10px 12px", color: "#111", fontSize: 15, outline: "none" };
const primaryBtn = { background: "#111", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "10px 16px" };
const ghostBtn = { background: "transparent", border: "1.5px solid #e0e0e0", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer", padding: "6px 12px" };
const navBtn = { background: "none", border: "none", color: "#ccc", fontSize: 26, cursor: "pointer", padding: "0 8px" };
