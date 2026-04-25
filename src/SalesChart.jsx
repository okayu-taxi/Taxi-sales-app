import { useRef, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from "recharts";

const DAY_WIDTH = 52;
const CHART_HEIGHT = 180;

export default function SalesChart({ chartData, fmt, onPointClick, todayIndex }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const idx = todayIndex != null && todayIndex >= 0 ? todayIndex : chartData.length - 1;
    const target = Math.max(0, idx * DAY_WIDTH - el.clientWidth / 2 + DAY_WIDTH / 2);
    el.scrollTo({ left: target, behavior: "auto" });
  }, [todayIndex, chartData.length]);

  const handleClick = (e) => {
    const p = e?.activePayload?.[0]?.payload;
    if (p && onPointClick) onPointClick(p.dateKey);
  };

  const chartWidth = Math.max(320, DAY_WIDTH * chartData.length + 40);

  return (
    <div ref={containerRef} style={{ overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch" }}>
      <LineChart
        width={chartWidth}
        height={CHART_HEIGHT}
        data={chartData}
        margin={{ top: 26, right: 20, left: 8, bottom: 4 }}
        onClick={handleClick}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: "#999", fontSize: 11 }} stroke="#eee" interval={0} />
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
    </div>
  );
}
