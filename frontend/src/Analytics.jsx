export default function Analytics({ data }) {
  const maxViews = Math.max(1, ...data.map((d) => d.pageViews));
  return (
    <section className="card">
      <h2>Analytics (last 7 days)</h2>
      <div className="chart">
        {data.map((d) => (
          <div key={d.date} className="bar-col" title={`${d.pageViews} page views`}>
            <span className="bar-value">{d.pageViews}</span>
            <div className="bar" style={{ height: `${(d.pageViews / maxViews) * 100}%` }} />
            <span className="bar-label">{d.date.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Date</th><th>Users</th><th>Page views</th><th>Bounce rate</th></tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td><td>{d.users}</td><td>{d.pageViews}</td><td>{d.bounceRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
