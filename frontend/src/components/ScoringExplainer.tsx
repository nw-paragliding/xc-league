// Scoring explainer — shown on the Overall tab alongside the standings

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text3)',
          fontFamily: 'var(--font-mono)',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ScorePill({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.05em',
        background: color + '18',
        color,
        border: `1px solid ${color}44`,
      }}
    >
      {label}
    </span>
  );
}

function ScoreRow({ pill, pillColor, label, sub }: { pill: string; pillColor: string; label: string; sub?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '9px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ flexShrink: 0, width: 80, paddingTop: 2 }}>
        <ScorePill label={pill} color={pillColor} />
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3, lineHeight: 1.5 }}>{sub}</div>}
      </div>
    </div>
  );
}

function TpRow({ dot, label, sub }: { dot: string; label: string; sub: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '8px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: dot,
          flexShrink: 0,
          marginTop: 3,
          boxShadow: `0 0 6px ${dot}66`,
        }}
      />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3, lineHeight: 1.5 }}>{sub}</div>
      </div>
    </div>
  );
}

export default function ScoringExplainer() {
  return (
    <div style={{ fontSize: 13, color: 'var(--text2)' }}>
      <Section title="Overview">
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, marginBottom: 10 }}>
          This is an <strong style={{ color: 'var(--text)' }}>async cross-country league</strong> — there's no mass
          start and no set flying day. Each task defines a route with GPS waypoints. You fly it whenever conditions
          allow during the open window, record the flight on any GPS logger or variometer, and upload the{' '}
          <strong style={{ color: 'var(--text)' }}>.igc file</strong> here.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, marginBottom: 10 }}>
          The route is designed so that going further, faster gets more points — but every pilot earns points for how
          far they get, so it's worth flying even if goal feels out of reach.
        </p>
        <div
          style={{
            padding: '9px 12px',
            borderRadius: 6,
            background: 'rgba(74,158,255,0.07)',
            border: '1px solid rgba(74,158,255,0.18)',
            fontSize: 12,
            color: 'var(--text3)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: '#4a9eff' }}>New to XC competition?</strong> Start with the task file — load it into
          XCTrack or a compatible app, fly as much of the route as you can, then upload your .igc track log when you
          land. That's it.
        </div>
      </Section>

      <Section title="Points">
        <ScoreRow
          pill="DISTANCE"
          pillColor="#e8a842"
          label="Awarded to every pilot"
          sub="Based on how far you flew along the optimised task route relative to the best result in the field. You score distance points even if you don't reach goal."
        />
        <ScoreRow
          pill="TIME"
          pillColor="#4a9eff"
          label="Goal pilots only"
          sub="Measures your speed through the speed section. Faster pilots and days with more goal crossings earn more time points. Provisional until the task closes — final standings depend on the full field."
        />
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            background: 'var(--bg3)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--text3)',
            lineHeight: 1.6,
          }}
        >
          <span style={{ color: 'var(--text2)', fontWeight: 600 }}>Total = Distance + Time.</span> Season standings sum
          your best result across all tasks. A missed task scores zero.
        </div>
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'var(--bg3)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--text3)',
            lineHeight: 1.6,
          }}
        >
          <span style={{ color: 'var(--text2)', fontWeight: 600 }}>Normalization.</span> Some tasks have a maximum score
          set (e.g. 1000 pts). When normalization is on, the task winner's raw score is scaled to that maximum and every
          other pilot's score scales proportionally — so the relative gaps between pilots are preserved.
        </div>
      </Section>

      <Section title="Course">
        <TpRow
          dot="#4a9eff"
          label="SSS — Start of Speed Section"
          sub="Exit this cylinder to start the clock. You may restart as many times as you like; only your best attempt counts."
        />
        <TpRow
          dot="#e8a842"
          label="Turnpoints"
          sub="Intermediate cylinders that must be entered in order to validate the leg."
        />
        <TpRow
          dot="#5db87a"
          label="ESS / Goal"
          sub="Crossing ESS stops the clock. Reaching the goal cylinder scores you full task distance."
        />
      </Section>

      <Section title="Restarts">
        <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.65 }}>
          You can re-cross the SSS cylinder as many times as you need. We automatically find the start that produced
          your furthest flight (or fastest time if you reached goal) and score that. All other attempts are discarded.
        </div>
      </Section>
    </div>
  );
}
