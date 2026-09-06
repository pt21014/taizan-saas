/** 每页顶部的标题块，样式统一，避免每页各写一份。 */
export function PageHead({
  eyebrow,
  title,
  desc,
}: {
  eyebrow?: string
  title: string
  desc?: string
}) {
  return (
    <section className="section" style={{ paddingBottom: 0 }}>
      <div className="container">
        <div className="section__head">
          {eyebrow && (
            <span
              style={{
                display: 'inline-block',
                color: 'var(--taizan-color-primary)',
                fontSize: 13,
                fontWeight: 700,
                marginBottom: 8,
              }}
            >
              {eyebrow}
            </span>
          )}
          <h1 style={{ fontSize: 34, margin: 0 }}>{title}</h1>
          {desc && <p style={{ marginTop: 12 }}>{desc}</p>}
        </div>
      </div>
    </section>
  )
}
