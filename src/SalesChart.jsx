import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from "recharts";

export default function SalesChart({ chartData, totalDays, fmt, onPointClick }) {
  const interval = totalDays > 14 ? Math.floor(totalDays / 7) : 0;
  const handleClick = (e) => {
    const p = e?.activePayload?.[0]?.payload;
    if (p && onPointClick) onPointClick(p.dateKey);
  };
  return (
    <ResponsiveContainer width="100%" height={170}>
      <LineChart data={chartData} margin={{ top: 22, right: 12, left: 4, bottom: 0 }} onClick={handleClick}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: "#999", fontSize: 11 }} stroke="#eee" interval={interval} />
        <YAxis hide domain={[0, "dataMax + 5000"]} />
        <Tooltip
          contentStyle={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 8, fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
          formatter={(v) => [`¥${fmt(v)}`, "売上"]}
        />
        <Line
          type="monotone"
          dataKey="売上"
          stroke="#3399ff"
          strokeWidth={2.5}
          connectNulls
          dot={{ r: 5, fill: "#fff", stroke: "#3399ff", strokeWidth: 2 }}
          activeDot={{ r: 8, cursor: "pointer", fill: "#3399ff", stroke: "#fff", strokeWidth: 2 }}
        >
          <LabelList
            dataKey="売上"
            position="top"
            fontSize={11}
            fill="#666"
            formatter={(v) => (v ? fmt(v) : "")}
          />
        </Line>
      </LineChart>
    </ResponsiveContainer>
  );
}
