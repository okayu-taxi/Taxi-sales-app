import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export default function SalesChart({ chartData, goal, totalDays, fmt }) {
  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="label" tick={{ fill: "#ccc", fontSize: 10 }} interval={Math.floor(totalDays / 6)} stroke="#f0f0f0" />
          <YAxis tick={{ fill: "#ccc", fontSize: 10 }} stroke="#f0f0f0" tickFormatter={v => `${(v / 10000).toFixed(0)}万`} />
          <Tooltip contentStyle={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 8, fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }} labelStyle={{ color: "#111" }} formatter={(v, n) => [`¥${fmt(v)}`, n]} />
          <Line type="monotone" dataKey="累計売上" stroke="#111" strokeWidth={2.5} dot={false} />
          {goal > 0 && <Line type="monotone" dataKey="目標ライン" stroke="#ccc" strokeWidth={1.5} strokeDasharray="5 5" dot={false} />}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: 16, marginTop: 12, justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#bbb" }}><div style={{ width: 20, height: 2, background: "#111" }} />累計売上</div>
        {goal > 0 && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#bbb" }}><div style={{ width: 20, height: 2, background: "#ccc" }} />目標ライン</div>}
      </div>
    </>
  );
}
