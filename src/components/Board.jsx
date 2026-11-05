import Column from "./Column.jsx";

export default function Board({ columns, byStatus, stats, onPatch }) {
  return (
    <div className="flex gap-4 overflow-x-auto">
      {columns.map((col) => (
        <Column
          key={col.key}
          col={col}
          jobs={byStatus[col.key] || []}
          count={stats[col.key] || 0}
          onPatch={onPatch}
        />
      ))}
    </div>
  );
}
