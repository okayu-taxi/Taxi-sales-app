import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const STORAGE_KEY = "taxi_sales_data_v3";

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
function getDaysLeft(period, today) {
  const dates = getDatesInPeriod(period);
  const idx = dates.findIndex(d => d.year === today.year && d.month === today.month && d.day === today.day);
  return { daysLeft: idx === -1 ? 0 : dates.length - idx, totalDays: dates.length };
}

const WEEKDAYS = ["日","月","火","水","木","金","土"];

export default function TaxiSalesApp() {
  const now = new Date();
  const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };

  const [curYear, setCurYear] = useState(today.year);
  const [curMonth, setCurMonth] = useState(today.month);
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
    try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : { settings: { closingDay: 0 }, periods: {}, attendance: {} }; }
    catch { return { settings: { closingDay: 0 }, periods: {}, attendance: {} }; }
  });

  const closingDay = data.settings?.closingDay ?? 0;
  const period = getPeriod(curYear, curMonth, closingDay);
  const pKey = `${period.startYear}-${period.startMonth}-${period.startDay}_${period.endYear}-${period.endMonth}-${period.endDay}`;
  const pData = data.periods?.[pKey] || { goal: 0, days: {} };
  const datesInPeriod = getDatesInPeriod(period);
  const attendance = data.attendance || {};

  useEffect(() => {
    const tin = datesInPeriod.find(d => d.year === today.year && d.month === today.month && d.day === today.day);
    const def = tin || datesInPeriod[0];
    if (def) setInputDateKey(`${def.year}-${def.month}-${def.day}`);
  }, [pKey]);

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} }, [data]);

  const updPeriod = (np) => setData(p => ({ ...p, periods: { ...p.periods, [pKey]: np } }));
  const saveDay = () => { const a = parseInt(inputAmount.replace(/,/g, "")); if (!a || isNaN(a)) return; updPeriod({ ...pData, days: { ...pData.days, [inputDateKey]: a } }); setInputAmount(""); };
  const saveGoal = () => { const g = parseInt(goalInput.replace(/,/g, "")); if (!g || isNaN(g)) return; updPeriod({ ...pData, goal: g }); setGoalInput(""); setEditingGoal(false); };
  const deleteDay = (key) => { const nd = { ...pData.days }; delete nd[key]; updPeriod({ ...pData, days: nd }); };
  const saveClosing = () => { const v = parseInt(closingInput); if (isNaN(v) || v < 0 || v > 28) return; setData(p => ({ ...p, settings: { ...p.settings, closingDay: v } })); setClosingInput(""); setEditingClosing(false); };
  const toggleAtt = (y, m, d) => { const key = `${y}-${m}-${d}`; const na = { ...attendance }; if (na[key]) delete na[key]; else na[key] = true; setData(p => ({ ...p, attendance: na })); };
  const isAtt = (y, m, d) => !!attendance[`${y}-${m}-${d}`];

  const total = Object.values(pData.days).reduce((a, b) => a + b, 0);
  const goal = pData.goal || 0;
  const remaining = Math.max(0, goal - total);
  const { daysLeft, totalDays } = getDaysLeft(period, today);
  const attLeft = datesInPeriod.filter(d => { const key = `${d.year}-${d.month}-${d.day}`; return attendance[key] && new Date(d.year, d.month, d.day) >= new Date(today.year, today.month, today.day); }).length;
  const hasAtt = Object.keys(attendance).length > 0;
  const effLeft = hasAtt ? attLeft : daysLeft;
  const dailyNeeded = effLeft > 0 ? Math.ceil(remaining / effLeft) : 0;
  const pct = goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0;

  let cum = 0;
  const chartData = datesInPeriod.map((d, i) => {
    cum += pData.days[`${d.year}-${d.month}-${d.day}`] || 0;
    return { label: `${d.month + 1}/${d.day}`, 累計売上: cum, 目標ライン: goal > 0 ? Math.round((goal / totalDays) * (i + 1)) : null };
  });

  const prevPeriod = () => { if (curMonth === 0) { setCurMonth(11); setCurYear(y => y - 1); } else setCurMonth(m => m - 1); };
  const nextPeriod = () => { if (curMonth === 11) { setCurMonth(0); setCurYear(y => y + 1); } else setCurMonth(m => m + 1); };
  const prevCal = () => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); } else setCalMonth(m => m - 1); };
  const nextCal = () => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); } else setCalMonth(m => m + 1); };

  const fmt = (n) => n.toLocaleString("ja-JP");
  const sortedKeys = Object.keys(pData.days).sort((a, b) => { const p = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m,d); }; return p(a)-p(b); });
  const fmtKey = (k) => { const [,m,d] = k.split("-").map(Number); return `${m+1}月${d}日`; };
  const closingLabel = closingDay === 0 ? "末日締め" : `毎月${closingDay}日締め`;

  const calDays = getDaysInMonth(calYear, calMonth);
  const calFirst = getFirstDayOfWeek(calYear, calMonth);
  const calCells = [...Array(calFirst).fill(null), ...Array.from({length: calDays}, (_, i) => i + 1)];
  const calAttCount = Array.from({length: calDays}, (_, i) => i + 1).filter(d => isAtt(calYear, calMonth, d)).length;

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
        {[["home","ホーム"],["graph","グラフ"],["calendar","カレンダー"],["history","履歴"],["settings","設定"]].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{ flex: 1, padding: "11px 0", border: "none", background: "none", color: activeTab === key ? "#111" : "#ccc", fontWeight: activeTab === key ? 700 : 400, fontSize: 11, cursor: "pointer", borderBottom: activeTab === key ? "2px solid #111" : "2px solid transparent", transition: "all 0.15s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "16px" }}>

        {activeTab === "home" && <>
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={lbl}>期間目標</span>
              <button onClick={() => { setEditingGoal(!editingGoal); setGoalInput(""); }} style={ghostBtn}>{editingGoal ? "キャンセル" : "設定"}</button>
            </div>
            {editingGoal ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input type="number" placeholder="目標額を入力" value={goalInput} onChange={e => setGoalInput(e.target.value)} style={inputStyle} onKeyDown={e => e.key === "Enter" && saveGoal()} />
                <button onClick={saveGoal} style={primaryBtn}>保存</button>
              </div>
            ) : <div style={{ fontSize: 34, fontWeight: 800 }}>¥{fmt(goal)}</div>}
          </div>

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
        </>}

        {activeTab === "graph" && (
          <div style={card}>
            <div style={{ ...lbl, marginBottom: 16 }}>売上推移</div>
            {Object.keys(pData.days).length === 0 ? (
              <div style={{ textAlign: "center", color: "#ccc", padding: "40px 0" }}>まだデータがありません</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="label" tick={{ fill: "#ccc", fontSize: 10 }} interval={Math.floor(totalDays/6)} stroke="#f0f0f0" />
                  <YAxis tick={{ fill: "#ccc", fontSize: 10 }} stroke="#f0f0f0" tickFormatter={v => `${(v/10000).toFixed(0)}万`} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 8, fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }} labelStyle={{ color: "#111" }} formatter={(v, n) => [`¥${fmt(v)}`, n]} />
                  <Line type="monotone" dataKey="累計売上" stroke="#111" strokeWidth={2.5} dot={false} />
                  {goal > 0 && <Line type="monotone" dataKey="目標ライン" stroke="#ccc" strokeWidth={1.5} strokeDasharray="5 5" dot={false} />}
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ display: "flex", gap: 16, marginTop: 12, justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#bbb" }}><div style={{ width: 20, height: 2, background: "#111" }} />累計売上</div>
              {goal > 0 && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#bbb" }}><div style={{ width: 20, height: 2, background: "#ccc" }} />目標ライン</div>}
            </div>
          </div>
        )}

        {activeTab === "calendar" && <>
          <div style={{ ...card, padding: "12px 16px", marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#aaa", lineHeight: 1.7 }}>日付をタップして出勤日を設定。出勤日を登録すると、ホームの必要売上が「残り出勤日ベース」で計算されます。</p>
          </div>
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <button onClick={prevCal} style={navBtn}>‹</button>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 17, fontWeight: 700 }}>{calYear}年{calMonth + 1}月</div>
                <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>出勤予定：{calAttCount}日</div>
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
                const worked = isAtt(calYear, calMonth, day);
                const dow = (calFirst + day - 1) % 7;
                return (
                  <button key={day} onClick={() => toggleAtt(calYear, calMonth, day)} style={{ border: worked ? "none" : isToday ? "2px solid #111" : "2px solid transparent", borderRadius: 9, padding: "7px 2px", cursor: "pointer", background: worked ? "#111" : "transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, transition: "all 0.12s" }}>
                    <span style={{ fontSize: 14, lineHeight: 1, fontWeight: worked || isToday ? 700 : 400, color: worked ? "#fff" : isToday ? "#111" : dow===0?"#e55":dow===6?"#55a":"#333" }}>{day}</span>
                    {worked && <span style={{ width: 3, height: 3, borderRadius: "50%", background: "#555" }} />}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 20, marginTop: 16, paddingTop: 14, borderTop: "1px solid #f0f0f0", justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "#999" }}><div style={{ width: 22, height: 22, background: "#111", borderRadius: 7 }} />出勤日</div>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "#999" }}><div style={{ width: 22, height: 22, border: "2px solid #111", borderRadius: 7 }} />今日</div>
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
            <div style={{ marginTop: 20, padding: "14px", background: "#f5f5f5", borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: "#bbb", marginBottom: 6, fontWeight: 600 }}>💡 データについて</div>
              <div style={{ fontSize: 12, color: "#aaa", lineHeight: 1.8 }}>データはこのデバイスに保存されます。毎日使う限りデータは消えません。App Store公開時にクラウド保存に対応予定です。</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const card = { background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, padding: "16px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.03)" };
const lbl = { fontSize: 10, color: "#bbb", letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase" };
const statBox = { background: "#f5f5f5", borderRadius: 10, padding: "12px 14px" };
const statLbl = { fontSize: 11, color: "#bbb", marginBottom: 4 };
const inputStyle = { flex: 1, background: "#f5f5f5", border: "1.5px solid #ebebeb", borderRadius: 8, padding: "10px 12px", color: "#111", fontSize: 15, outline: "none" };
const primaryBtn = { background: "#111", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", padding: "10px 16px" };
const ghostBtn = { background: "transparent", border: "1.5px solid #e0e0e0", borderRadius: 8, color: "#888", fontSize: 12, cursor: "pointer", padding: "6px 12px" };
const navBtn = { background: "none", border: "none", color: "#ccc", fontSize: 26, cursor: "pointer", padding: "0 8px" };
