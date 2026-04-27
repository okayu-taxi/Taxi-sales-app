import { useRef, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from "recharts";

const DAY_WIDTH = 52;
const CHART_HEIGHT = 200;
const SALES_COLOR = "#3399ff";

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

  const renderSalesLabel = ({ x, y, value }) => {
    if (!value) return null;
    return (
      <text
        x={x}
        y={y - 14}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill="#555"
        style={{ pointerEvents: "none" }}
      >
        {fmt(value)}
      </text>
    );
  };

  return (
    <div ref={containerRef} style={{ overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch" }}>
      <LineChart
        width={chartWidth}
        height={CHART_HEIGHT}
        data={chartData}
        margin={{ top: 32, right: 24, left: 24, bottom: 4 }}
        onClick={handleClick}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
        <XAxis
          dataKey="label"
          stroke="#eee"
          interval={0}
          tick={(props) => {
            const { x, y, payload, index } = props;
            const datum = chartData[index];
            return (
              <g style={{ cursor: "pointer" }} onClick={() => datum && onPointClick && onPointClick(datum.dateKey)}>
                <rect x={x - DAY_WIDTH / 2} y={y - 14} width={DAY_WIDTH} height={32} fill="transparent" />
                <text x={x} y={y + 4} textAnchor="middle" fill="#999" fontSize={11}>{payload.value}</text>
              </g>
            );
          }}
        />
        <YAxis hide domain={[0, "dataMax + 5000"]} />
        <Tooltip
          contentStyle={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 8, fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
          formatter={(v, n) => [`¥${fmt(v)}`, n]}
        />
        <Line
          type="monotone"
          dataKey="売上"
          stroke={SALES_COLOR}
          strokeWidth={2.5}
          connectNulls
          dot={{ r: 5, fill: "#fff", stroke: SALES_COLOR, strokeWidth: 2 }}
          activeDot={{ r: 8, cursor: "pointer", fill: SALES_COLOR, stroke: "#fff", strokeWidth: 2 }}
        >
          <LabelList dataKey="売上" content={renderSalesLabel} />
        </Line>
      </LineChart>
    </div>
  );
}
