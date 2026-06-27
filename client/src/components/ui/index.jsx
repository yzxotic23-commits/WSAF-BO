import './ui.css';

export function PageHeader({ title, description, actions }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = '', padding = true }) {
  return (
    <div className={`ff-card${padding ? ' padded' : ''} ${className}`}>
      {children}
    </div>
  );
}

export function StatCard({ label, value, hint, tone = 'default' }) {
  return (
    <div className={`ff-stat tone-${tone}`}>
      <div className="ff-stat-label">{label}</div>
      <div className="ff-stat-value">{value}</div>
      {hint && <div className="ff-stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'default' }) {
  return <span className={`ff-badge tone-${tone}`}>{children}</span>;
}

export function Button({ children, variant = 'primary', size = 'md', icon: Icon, ...props }) {
  return (
    <button type="button" className={`ff-btn variant-${variant} size-${size}`} {...props}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function EmptyState({ icon: Icon, title, description }) {
  return (
    <div className="ff-empty">
      {Icon && <Icon size={28} strokeWidth={1.5} />}
      <div className="ff-empty-title">{title}</div>
      {description && <div className="ff-empty-desc">{description}</div>}
    </div>
  );
}

export function DataTable({ columns, rows, onRowClick }) {
  return (
    <div className="ff-table-wrap">
      <table className="ff-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="ff-table-empty">
                No data
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'clickable' : ''}
              >
                {columns.map((col) => (
                  <td key={col.key}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Spinner() {
  return <div className="ff-spinner" aria-label="Loading" />;
}
