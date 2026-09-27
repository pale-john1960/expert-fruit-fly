"use client";

/**
 * HowItWorksDiagrams — three hand-crafted, animated SVG illustrations for the
 * How It Works tab. Each diagram is fully self-contained: its own scoped
 * <style> block (class prefix `hiw-`), a desktop (horizontal) variant shown
 * at md+, and a stacked variant for narrow viewports, both viewBox-scaled.
 *
 * Region colors mirror REGION_META in BrainVisualizer3D.tsx (duplicated as
 * literals so the docs tab never pulls three.js into its bundle). Light mode
 * uses slightly deeper strokes of the same hues for contrast on white; text
 * uses the theme's --foreground / --muted-foreground via CSS classes so both
 * modes stay correct. Animations are pure CSS keyframes and are switched off
 * under prefers-reduced-motion.
 */

import { motion } from "framer-motion";

/* ---------------------------------------------------------------- helpers */

/** Region hues — byte-identical to BrainVisualizer3D's REGION_META. */
export const REGION_HEX: Record<string, string> = {
  retina: "#f59e0b",
  lamina: "#fbbf24",
  medulla: "#2dd4bf",
  lobula: "#34d399",
  kenyon: "#e879f9",
  mbon: "#34d399",
  motor: "#fde047",
};

const ROSE = "#fb7185";
const AMBER = "#f59e0b";

/** Tiny arrowhead marker (points +x; rotate as needed). */
function Arrow({
  x,
  y,
  a = 0,
  s = 1,
  className,
  fill,
}: {
  x: number;
  y: number;
  a?: number;
  s?: number;
  className?: string;
  fill?: string;
}) {
  return (
    <path
      d="M -6.5 -5 L 6.5 0 L -6.5 5 Z"
      transform={`translate(${x} ${y}) rotate(${a}) scale(${s})`}
      className={className}
      fill={fill}
      aria-hidden="true"
    />
  );
}

/** Shared entrance for each diagram (subtle, once). */
function DiagramShell({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="hiw-diagram"
      role="group"
      aria-label={label}
    >
      {children}
    </motion.div>
  );
}

/* ============================================================================
 * DIAGRAM 1 — Signal pipeline (7 regions, graded vs spiking, fixed vs plastic)
 * ========================================================================== */

interface RegionDef {
  key: string;
  name: string;
  count: string;
  /** desktop two-line caption */
  cap1: string;
  cap2: string;
  /** single-line caption for the narrow variant */
  capM: string;
  graded: boolean;
}

const REGIONS: RegionDef[] = [
  { key: "retina", name: "Retina", count: "216", cap1: "the eye —", cap2: "brightness pixels", capM: "the eye · brightness only", graded: true },
  { key: "lamina", name: "Lamina", count: "216", cap1: "keeps what", cap2: "changes", capM: "keeps what changes", graded: true },
  { key: "medulla", name: "Medulla", count: "192", cap1: "spots · edges ·", cap2: "motion channels", capM: "spots · edges · motion", graded: true },
  { key: "lobula", name: "Lobula", count: "48", cap1: "one neuron per", cap2: "view patch", capM: "one neuron per patch", graded: false },
  { key: "kenyon", name: "Kenyon", count: "240", cap1: "sparse code of", cap2: "right now", capM: "sparse code of right now", graded: false },
  { key: "mbon", name: "MBONs", count: "12", cap1: "approach / avoid", cap2: "memory outputs", capM: "approach / avoid memory", graded: false },
  { key: "motor", name: "Motor", count: "2–4", cap1: "jump · duck ·", cap2: "steer · pedal", capM: "jump · duck · steer · pedal", graded: false },
];

const PIPELINE_STYLE = `
.hiw-diagram .hiw-t { fill: var(--foreground); }
.hiw-diagram .hiw-tm { fill: var(--muted-foreground); }
.hiw-diagram .hiw-card { fill: var(--card); }
.hiw-diagram .hiw-line { stroke: var(--muted-foreground); }
.hiw-diagram .hiw-fm { fill: var(--muted-foreground); }
.hiw-diagram .hiw-s-retina { stroke: #d97706; fill: #f59e0b; }
.hiw-diagram .hiw-s-lamina { stroke: #b45309; fill: #fbbf24; }
.hiw-diagram .hiw-s-medulla { stroke: #0d9488; fill: #2dd4bf; }
.hiw-diagram .hiw-s-lobula { stroke: #059669; fill: #34d399; }
.hiw-diagram .hiw-s-kenyon { stroke: #c026d3; fill: #e879f9; }
.hiw-diagram .hiw-s-mbon { stroke: #059669; fill: #34d399; }
.hiw-diagram .hiw-s-shock { stroke: #be123c; fill: #fb7185; }
.hiw-diagram .hiw-s-motor { stroke: #ca8a04; fill: #fde047; }
.dark .hiw-diagram .hiw-s-retina { stroke: #f59e0b; }
.dark .hiw-diagram .hiw-s-lamina { stroke: #fbbf24; }
.dark .hiw-diagram .hiw-s-medulla { stroke: #2dd4bf; }
.dark .hiw-diagram .hiw-s-lobula { stroke: #34d399; }
.dark .hiw-diagram .hiw-s-kenyon { stroke: #e879f9; }
.dark .hiw-diagram .hiw-s-mbon { stroke: #34d399; }
.dark .hiw-diagram .hiw-s-shock { stroke: #fb7185; }
.dark .hiw-diagram .hiw-s-motor { stroke: #fde047; }
.hiw-diagram .hiw-eml { stroke: #059669; }
.dark .hiw-diagram .hiw-eml { stroke: #34d399; }
.hiw-diagram .hiw-emt { fill: #047857; }
.dark .hiw-diagram .hiw-emt { fill: #6ee7b7; }
.hiw-diagram .hiw-emf { fill: #059669; }
.dark .hiw-diagram .hiw-emf { fill: #34d399; }
@keyframes hiw-flow-x {
  0% { transform: translateX(0); opacity: 0; }
  6% { opacity: 1; }
  94% { opacity: 1; }
  100% { transform: translateX(924px); opacity: 0; }
}
@keyframes hiw-flow-y {
  0% { transform: translateY(0); opacity: 0; }
  6% { opacity: 1; }
  94% { opacity: 1; }
  100% { transform: translateY(562px); opacity: 0; }
}
@keyframes hiw-knob { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.hiw-diagram .hiw-dot { animation: hiw-flow-x 7.2s linear infinite; }
.hiw-diagram .hiw-doty { animation: hiw-flow-y 7.2s linear infinite; }
.hiw-diagram .hiw-knob { animation: hiw-knob 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .hiw-diagram .hiw-anim { animation: none !important; }
}
`;

export function PipelineDiagram() {
  return (
    <DiagramShell label="Signal pipeline diagram">
      <style>{PIPELINE_STYLE}</style>
      <figure className="m-0">
        {/* ---- desktop: horizontal pipeline ---- */}
        <div className="hidden md:block">
          <svg
            viewBox="0 0 980 244"
            role="img"
            aria-label="Signal pipeline: retina with 216 neurons feeds lamina 216, medulla 192, lobula 48, kenyon cells 240, MBONs 12 and motor neurons 2 to 4. Retina, lamina and medulla are graded; lobula onward are spiking. Wiring up to the kenyon cells is innate; the kenyon-to-MBON and MBON-to-motor synapses are plastic."
            className="h-auto w-full"
          >
            <title>Signal pipeline — seven regions, 928 neurons end to end</title>
            <g strokeLinecap="round" strokeLinejoin="round">
              {/* graded / spiking group brackets */}
              <text x={958} y={18} textAnchor="end" fontSize={11} fontStyle="italic" className="hiw-tm">
                928 neurons end-to-end
              </text>
              <path d="M 34 50 V 44 H 414 V 50" fill="none" className="hiw-line" strokeWidth={1.4} strokeOpacity={0.5} />
              <text x={224} y={36} textAnchor="middle" fontSize={13.5} className="hiw-tm">
                graded — analog voltages
              </text>
              <path d="M 442 50 V 44 H 958 V 50" fill="none" className="hiw-line" strokeWidth={1.4} strokeOpacity={0.5} strokeDasharray="5 4" />
              <text x={700} y={36} textAnchor="middle" fontSize={13.5} className="hiw-tm">
                spiking — leaky integrate-and-fire
              </text>

              {/* regions */}
              {REGIONS.map((r, i) => {
                const x = 34 + i * 136;
                const plasticAfter = i === 4 || i === 5; // K→M and M→motor synapses
                return (
                  <g key={r.key}>
                    <rect x={x} y={72} width={108} height={64} rx={10} className={`hiw-s-${r.key}`} fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
                    {r.key === "mbon" ? (
                      <>
                        <rect x={x + 8} y={79} width={44} height={4.5} rx={2.25} className="hiw-s-mbon" />
                        <rect x={x + 56} y={79} width={44} height={4.5} rx={2.25} className="hiw-s-shock" />
                      </>
                    ) : (
                      <rect x={x + 8} y={79} width={92} height={4.5} rx={2.25} className={`hiw-s-${r.key}`} />
                    )}
                    <text x={x + 54} y={100} textAnchor="middle" fontSize={17} fontWeight={600} className="hiw-t">
                      {r.name}
                    </text>
                    <rect x={x + 29} y={108} width={50} height={17} rx={8.5} className={`hiw-s-${r.key}`} fillOpacity={0.16} strokeOpacity={0.5} strokeWidth={1} />
                    <text x={x + 54} y={120.5} textAnchor="middle" fontSize={12.5} className="hiw-t">
                      {r.count}
                    </text>
                    <text x={x + 54} y={152} textAnchor="middle" fontSize={13.5} className="hiw-tm">
                      {r.cap1}
                    </text>
                    <text x={x + 54} y={167} textAnchor="middle" fontSize={13.5} className="hiw-tm">
                      {r.cap2}
                    </text>
                    {/* connector to the next region */}
                    {i < 6 && (
                      <g aria-hidden="true">
                        <line
                          x1={x + 111}
                          y1={104}
                          x2={x + 133}
                          y2={104}
                          className={plasticAfter ? "hiw-eml" : "hiw-line"}
                          strokeWidth={plasticAfter ? 2 : 1.8}
                          strokeOpacity={plasticAfter ? 0.9 : 0.45}
                          strokeDasharray={plasticAfter ? "4 3" : undefined}
                        />
                        {plasticAfter ? (
                          <>
                            <circle cx={x + 119} cy={104} r={4.5} fill={REGION_HEX.lobula} className="hiw-anim hiw-knob" />
                            <Arrow x={x + 128.5} y={104} s={0.72} className="hiw-emf" />
                          </>
                        ) : (
                          <Arrow x={x + 127} y={104} s={0.85} className="hiw-fm" />
                        )}
                      </g>
                    )}
                  </g>
                );
              })}

              {/* fixed vs plastic brackets */}
              <path d="M 34 190 V 196 H 686 V 190" fill="none" className="hiw-line" strokeWidth={1.4} strokeOpacity={0.5} />
              <text x={360} y={214} textAnchor="middle" fontSize={13.5} className="hiw-tm">
                innate (fixed) wiring — born with it
              </text>
              <path d="M 686 190 V 196 H 958 V 190" fill="none" className="hiw-eml" strokeWidth={1.4} strokeOpacity={0.85} />
              <text x={822} y={214} textAnchor="middle" fontSize={13.5} className="hiw-emt" fontWeight={600}>
                learnable (plastic) synapses
              </text>
              <text x={822} y={231} textAnchor="middle" fontSize={11} className="hiw-tm" fontStyle="italic">
                sugar &amp; shock retune these
              </text>

              {/* traveling signal dots */}
              <g aria-hidden="true">
                {[0, -2.4, -4.8].map((delay) => (
                  <g key={delay} transform="translate(34 104)">
                    <g className="hiw-anim hiw-dot" style={{ animationDelay: `${delay}s` }}>
                      <circle r={10} fill="#fbbf24" opacity={0.3} />
                      <circle r={4.5} fill={AMBER} />
                    </g>
                  </g>
                ))}
              </g>
            </g>
          </svg>
        </div>

        {/* ---- mobile: stacked pipeline ---- */}
        <div className="mx-auto w-full max-w-[420px] md:hidden">
          <svg
            viewBox="0 0 360 648"
            role="img"
            aria-label="Signal pipeline, stacked: retina 216, lamina 216, medulla 192, lobula 48, kenyon cells 240, MBONs 12, motor 2 to 4. First three regions graded, later regions spiking; the last two synapses are plastic."
            className="h-auto w-full"
          >
            <title>Signal pipeline — seven regions, 928 neurons end to end</title>
            <g strokeLinecap="round" strokeLinejoin="round">
              {REGIONS.map((r, i) => {
                const y = 24 + i * 84;
                const plasticAfter = i === 4 || i === 5;
                return (
                  <g key={r.key}>
                    <rect x={12} y={y} width={168} height={58} rx={10} className={`hiw-s-${r.key}`} fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
                    {r.key === "mbon" ? (
                      <>
                        <rect x={54} y={y + 7} width={40} height={4.5} rx={2.25} className="hiw-s-mbon" />
                        <rect x={98} y={y + 7} width={40} height={4.5} rx={2.25} className="hiw-s-shock" />
                      </>
                    ) : (
                      <rect x={34} y={y + 7} width={56} height={4.5} rx={2.25} className={`hiw-s-${r.key}`} />
                    )}
                    <text x={96} y={y + 28} textAnchor="middle" fontSize={16} fontWeight={600} className="hiw-t">
                      {r.name}
                    </text>
                    <rect x={70} y={y + 34} width={52} height={17} rx={8.5} className={`hiw-s-${r.key}`} fillOpacity={0.16} strokeOpacity={0.5} strokeWidth={1} />
                    <text x={96} y={y + 46.5} textAnchor="middle" fontSize={11.5} className="hiw-t">
                      {r.count}
                    </text>
                    {/* caption + graded/spiking chip */}
                    <text x={192} y={y + 24} fontSize={11.5} className="hiw-tm">
                      {r.capM}
                    </text>
                    <rect
                      x={192}
                      y={y + 31}
                      width={56}
                      height={15}
                      rx={7.5}
                      fill="none"
                      className="hiw-line"
                      strokeWidth={1}
                      strokeOpacity={0.45}
                      strokeDasharray={r.graded ? undefined : "3 3"}
                    />
                    <text x={220} y={y + 42} textAnchor="middle" fontSize={8.5} letterSpacing={1} className="hiw-tm">
                      {r.graded ? "GRADED" : "SPIKING"}
                    </text>
                    {/* connector down to the next region */}
                    {i < 6 && (
                      <g aria-hidden="true">
                        <line
                          x1={96}
                          y1={y + 61}
                          x2={96}
                          y2={y + 83}
                          className={plasticAfter ? "hiw-eml" : "hiw-line"}
                          strokeWidth={plasticAfter ? 2 : 1.8}
                          strokeOpacity={plasticAfter ? 0.9 : 0.45}
                          strokeDasharray={plasticAfter ? "4 3" : undefined}
                        />
                        {plasticAfter ? (
                          <>
                            <circle cx={96} cy={y + 69} r={4.5} fill={REGION_HEX.lobula} className="hiw-anim hiw-knob" />
                            <Arrow x={96} y={y + 79} a={90} s={0.72} className="hiw-emf" />
                          </>
                        ) : (
                          <Arrow x={96} y={y + 78} a={90} s={0.85} className="hiw-fm" />
                        )}
                      </g>
                    )}
                  </g>
                );
              })}

              {/* legend */}
              <g aria-hidden="true">
                <line x1={12} y1={604} x2={32} y2={604} className="hiw-line" strokeWidth={2} strokeOpacity={0.55} />
                <text x={38} y={608} fontSize={10.5} className="hiw-tm">graded (analog)</text>
                <line x1={150} y1={604} x2={170} y2={604} className="hiw-line" strokeWidth={2} strokeOpacity={0.55} strokeDasharray="4 3" />
                <text x={176} y={608} fontSize={10.5} className="hiw-tm">spiking (LIF)</text>
                <line x1={12} y1={632} x2={32} y2={632} className="hiw-eml" strokeWidth={2} strokeOpacity={0.9} strokeDasharray="4 3" />
                <circle cx={17} cy={632} r={4} fill={REGION_HEX.lobula} />
                <text x={38} y={636} fontSize={10.5} className="hiw-tm">learnable (plastic)</text>
                <line x1={196} y1={632} x2={216} y2={632} className="hiw-line" strokeWidth={2} strokeOpacity={0.55} />
                <text x={222} y={636} fontSize={10.5} className="hiw-tm">innate (fixed)</text>
              </g>

              {/* traveling signal dots */}
              <g aria-hidden="true">
                {[0, -2.4, -4.8].map((delay) => (
                  <g key={delay} transform="translate(96 24)">
                    <g className="hiw-anim hiw-doty" style={{ animationDelay: `${delay}s` }}>
                      <circle r={9} fill="#fbbf24" opacity={0.3} />
                      <circle r={4} fill={AMBER} />
                    </g>
                  </g>
                ))}
              </g>
            </g>
          </svg>
        </div>

        <figcaption className="mt-2 text-center text-xs text-muted-foreground">
          Amber dots trace the signal streaming through the seven regions,
          tick by tick. Colors match the 3-D brain viewer.
        </figcaption>
      </figure>
    </DiagramShell>
  );
}

/* ============================================================================
 * DIAGRAM 2 — Dopamine 3-factor learning loop
 * ========================================================================== */

const D2_RING =
  "M 170 75 H 470 Q 530 75 530 135 V 315 Q 530 375 470 375 H 170 Q 110 375 110 315 V 135 Q 110 75 170 75 Z";
const D2_LOOP_M = "M 194 43 L 194 505 L 32 505 L 32 43 Z";

const DOPAMINE_STYLE = `
.hiw-diagram .hiw-t { fill: var(--foreground); }
.hiw-diagram .hiw-tm { fill: var(--muted-foreground); }
.hiw-diagram .hiw-card { fill: var(--card); }
.hiw-diagram .hiw-line { stroke: var(--muted-foreground); }
.hiw-diagram .hiw-fm { fill: var(--muted-foreground); }
.hiw-diagram .hiw-s-cue { stroke: #d97706; fill: #f59e0b; }
.hiw-diagram .hiw-s-kenyon { stroke: #c026d3; fill: #e879f9; }
.hiw-diagram .hiw-s-mbon { stroke: #059669; fill: #34d399; }
.hiw-diagram .hiw-s-shock { stroke: #be123c; fill: #fb7185; }
.hiw-diagram .hiw-s-beh { stroke: #0d9488; fill: #2dd4bf; }
.dark .hiw-diagram .hiw-s-cue { stroke: #f59e0b; }
.dark .hiw-diagram .hiw-s-kenyon { stroke: #e879f9; }
.dark .hiw-diagram .hiw-s-mbon { stroke: #34d399; }
.dark .hiw-diagram .hiw-s-shock { stroke: #fb7185; }
.dark .hiw-diagram .hiw-s-beh { stroke: #2dd4bf; }
.hiw-diagram .hiw-eml { stroke: #059669; }
.dark .hiw-diagram .hiw-eml { stroke: #34d399; }
.hiw-diagram .hiw-emt { fill: #047857; }
.dark .hiw-diagram .hiw-emt { fill: #6ee7b7; }
.hiw-diagram .hiw-emf { fill: #059669; }
.dark .hiw-diagram .hiw-emf { fill: #34d399; }
.hiw-diagram .hiw-rol { stroke: #be123c; }
.dark .hiw-diagram .hiw-rol { stroke: #fb7185; }
.hiw-diagram .hiw-rot { fill: #be123c; }
.dark .hiw-diagram .hiw-rot { fill: #fda4af; }
.hiw-diagram .hiw-rof { fill: #be123c; }
.dark .hiw-diagram .hiw-rof { fill: #fb7185; }
.hiw-diagram .hiw-tet { fill: #0f766e; }
.dark .hiw-diagram .hiw-tet { fill: #5eead4; }
@keyframes hiw-d2-orbit { from { offset-distance: 0%; } to { offset-distance: 100%; } }
.hiw-diagram .hiw-d2-dotd { offset-path: path("${D2_RING}"); animation: hiw-d2-orbit 12s linear infinite; }
.hiw-diagram .hiw-d2-dotm { offset-path: path("${D2_LOOP_M}"); animation: hiw-d2-orbit 12s linear infinite; }
@keyframes hiw-d2-dash { to { stroke-dashoffset: -36; } }
@keyframes hiw-d2-blink-e { 0%, 38% { opacity: 1; } 55%, 92% { opacity: 0.25; } 100% { opacity: 1; } }
@keyframes hiw-d2-blink-r { 0%, 42% { opacity: 0.25; } 58%, 90% { opacity: 1; } 100% { opacity: 0.25; } }
.hiw-diagram .hiw-dae { animation: hiw-d2-dash 1.2s linear infinite, hiw-d2-blink-e 3.6s ease-in-out infinite; }
.hiw-diagram .hiw-dar { animation: hiw-d2-dash 1.2s linear infinite, hiw-d2-blink-r 3.6s ease-in-out infinite; }
@keyframes hiw-d2-pulse {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50% { transform: scale(1.4); opacity: 0.15; }
}
.hiw-diagram .hiw-pul { transform-box: fill-box; transform-origin: center; animation: hiw-d2-pulse 3.6s ease-in-out infinite; }
.hiw-diagram .hiw-pul-r { animation-delay: -1.8s; }
@media (prefers-reduced-motion: reduce) {
  .hiw-diagram .hiw-anim { animation: none !important; }
}
`;

function SynapseKnob({ x, y, r = 13 }: { x: number; y: number; r?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r + 3} fill="none" className="hiw-eml hiw-anim hiw-pul" strokeWidth={2} aria-hidden="true" />
      <circle cx={x} cy={y} r={r + 3} fill="none" className="hiw-rol hiw-anim hiw-pul hiw-pul-r" strokeWidth={2} aria-hidden="true" />
      <circle cx={x} cy={y} r={r} className="hiw-card hiw-line" strokeWidth={1.4} />
      <text x={x} y={y + 3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} className="hiw-t font-mono">
        Δw
      </text>
    </g>
  );
}

export function DopamineLoopDiagram() {
  return (
    <DiagramShell label="Dopamine three-factor learning loop diagram">
      <style>{DOPAMINE_STYLE}</style>
      <figure className="m-0">
        {/* ---- desktop: ring loop ---- */}
        <div className="mx-auto hidden max-w-[620px] md:block">
          <svg
            viewBox="0 0 700 500"
            role="img"
            aria-label="Learning loop: a cue leads to a kenyon-cell code, then to MBONs, then to behavior, which changes the next cue. Sugar and shock feed dopamine into the kenyon-to-MBON synapse, where delta-w equals learning rate times dopamine times eligibility."
            className="h-auto w-full"
          >
            <title>Dopamine 3-factor loop — reward and punishment retune the K→M synapse</title>
            <g strokeLinecap="round" strokeLinejoin="round">
              {/* loop ring + direction arrows */}
              <path d={D2_RING} fill="none" className="hiw-line" strokeWidth={2} strokeOpacity={0.55} strokeDasharray="7 5" />
              <Arrow x={515} y={90} a={45} className="hiw-fm" />
              <Arrow x={530} y={268} a={90} className="hiw-fm" />
              <Arrow x={125} y={360} a={225} className="hiw-fm" />
              <Arrow x={125} y={90} a={315} className="hiw-fm" />

              {/* cue */}
              <rect x={220} y={47} width={220} height={56} rx={12} className="hiw-card" />
              <rect x={220} y={47} width={220} height={56} rx={12} className="hiw-s-cue" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={234} y={54} width={192} height={4.5} rx={2.25} className="hiw-s-cue" />
              <text x={330} y={74} textAnchor="middle" fontSize={15} fontWeight={600} letterSpacing={1} className="hiw-t">CUE</text>
              <text x={330} y={92} textAnchor="middle" fontSize={11} className="hiw-tm">a bar sweeps across the eye</text>

              {/* kenyon code */}
              <rect x={445} y={193} width={170} height={64} rx={12} className="hiw-card" />
              <rect x={445} y={193} width={170} height={64} rx={12} className="hiw-s-kenyon" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={461} y={200} width={138} height={4.5} rx={2.25} className="hiw-s-kenyon" />
              <text x={530} y={222} textAnchor="middle" fontSize={13.5} fontWeight={600} className="hiw-t">KENYON CODE</text>
              <text x={530} y={241} textAnchor="middle" fontSize={10.5} className="hiw-tm">sparse snapshot of “now”</text>

              {/* MBON */}
              <rect x={220} y={343} width={220} height={64} rx={12} className="hiw-card" />
              <rect x={220} y={343} width={220} height={64} rx={12} className="hiw-s-mbon" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={234} y={350} width={94} height={4.5} rx={2.25} className="hiw-s-mbon" />
              <rect x={332} y={350} width={94} height={4.5} rx={2.25} className="hiw-s-shock" />
              <text x={330} y={369} textAnchor="middle" fontSize={15} fontWeight={600} className="hiw-t">MBONs</text>
              <rect x={246} y={381} width={70} height={16} rx={8} className="hiw-s-mbon" fillOpacity={0.16} strokeOpacity={0.5} strokeWidth={1} />
              <text x={281} y={392.5} textAnchor="middle" fontSize={10} className="hiw-emt" fontWeight={600}>approach</text>
              <rect x={344} y={381} width={56} height={16} rx={8} className="hiw-s-shock" fillOpacity={0.16} strokeOpacity={0.5} strokeWidth={1} />
              <text x={372} y={392.5} textAnchor="middle" fontSize={10} className="hiw-rot" fontWeight={600}>avoid</text>

              {/* behavior */}
              <rect x={35} y={197} width={150} height={56} rx={12} className="hiw-card" />
              <rect x={35} y={197} width={150} height={56} rx={12} className="hiw-s-beh" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={49} y={204} width={122} height={4.5} rx={2.25} className="hiw-s-beh" />
              <text x={110} y={224} textAnchor="middle" fontSize={13.5} fontWeight={600} className="hiw-t">BEHAVIOR</text>
              <text x={110} y={242} textAnchor="middle" fontSize={10} className="hiw-tm">jump · duck · steer</text>

              {/* sugar + shock → dopamine arrows → synapse knob */}
              <rect x={620} y={249} width={75} height={42} rx={9} fill={REGION_HEX.lobula} fillOpacity={0.15} className="hiw-eml" strokeWidth={1.5} />
              <text x={657} y={266} textAnchor="middle" fontSize={12} fontWeight={700} letterSpacing={1} className="hiw-emt">SUGAR</text>
              <text x={657} y={281} textAnchor="middle" fontSize={9.5} className="hiw-tm">reward</text>
              <rect x={620} y={319} width={75} height={42} rx={9} fill={ROSE} fillOpacity={0.15} className="hiw-rol" strokeWidth={1.5} />
              <text x={657} y={336} textAnchor="middle" fontSize={12} fontWeight={700} letterSpacing={1} className="hiw-rot">SHOCK</text>
              <text x={657} y={351} textAnchor="middle" fontSize={9.5} className="hiw-tm">punish</text>

              <g aria-hidden="true">
                <path d="M 620 283 L 554 299" fill="none" className="hiw-eml hiw-anim hiw-dae" strokeWidth={2} strokeDasharray="5 4" />
                <Arrow x={554} y={299} a={166} s={0.85} className="hiw-emf" />
                <path d="M 620 337 L 554 313" fill="none" className="hiw-rol hiw-anim hiw-dar" strokeWidth={2} strokeDasharray="5 4" />
                <Arrow x={554} y={313} a={200} s={0.85} className="hiw-rof" />
              </g>
              <text x={586} y={309} textAnchor="middle" fontSize={9} fontStyle="italic" className="hiw-tm">dopamine</text>

              <SynapseKnob x={530} y={305} />
              <text x={542} y={286} fontSize={9.5} fontStyle="italic" className="hiw-tm">K→M synapse</text>

              {/* formula, anchored to the synapse by a dashed leader */}
              <path d="M 543 322 C 585 365, 575 420, 503 449" fill="none" className="hiw-line" strokeWidth={1.2} strokeDasharray="3 4" strokeOpacity={0.5} />
              <rect x={140} y={432} width={360} height={48} rx={10} className="hiw-card" />
              <rect x={140} y={432} width={360} height={48} rx={10} fill="none" className="hiw-line" strokeWidth={1.4} strokeDasharray="5 4" strokeOpacity={0.6} />
              <text x={320} y={450} textAnchor="middle" fontSize={9.5} letterSpacing={1.5} className="hiw-tm">THE 3-FACTOR LEARNING RULE</text>
              <text x={320} y={471} textAnchor="middle" fontSize={13.5} className="hiw-t font-mono">
                Δw = learningRate × <tspan className="hiw-emt">dopamine</tspan> × <tspan className="hiw-tet">eligibility</tspan>
              </text>

              {/* orbiting loop dot */}
              <g className="hiw-anim hiw-d2-dotd" aria-hidden="true">
                <circle r={10} fill={AMBER} opacity={0.22} />
                <circle r={4.5} fill={AMBER} />
              </g>
            </g>
          </svg>
        </div>

        {/* ---- mobile: stacked loop ---- */}
        <div className="mx-auto w-full max-w-[420px] md:hidden">
          <svg
            viewBox="0 0 380 552"
            role="img"
            aria-label="Learning loop, stacked: cue, kenyon code, the delta-w synapse fed by sugar and shock dopamine, MBONs, behavior, and back to the cue."
            className="h-auto w-full"
          >
            <title>Dopamine 3-factor loop — stacked layout</title>
            <g strokeLinecap="round" strokeLinejoin="round">
              {/* loop-back rail on the left */}
              <path d="M 84 505 H 32 V 43 H 78" fill="none" className="hiw-line" strokeWidth={1.8} strokeDasharray="6 5" strokeOpacity={0.55} />
              <Arrow x={80} y={43} className="hiw-fm" />
              <text x={20} y={274} textAnchor="middle" fontSize={9.5} className="hiw-tm" transform="rotate(-90 20 274)">
                behavior changes what the fly sees next
              </text>

              {/* main spine */}
              <line x1={194} y1={70} x2={194} y2={110} className="hiw-line" strokeWidth={1.8} strokeOpacity={0.55} strokeDasharray="6 5" />
              <Arrow x={194} y={96} a={90} className="hiw-fm" />
              <line x1={194} y1={164} x2={194} y2={306} className="hiw-line" strokeWidth={1.8} strokeOpacity={0.55} strokeDasharray="6 5" />
              <Arrow x={194} y={180} a={90} className="hiw-fm" />
              <line x1={194} y1={354} x2={194} y2={380} className="hiw-line" strokeWidth={1.8} strokeOpacity={0.55} strokeDasharray="6 5" />
              <Arrow x={194} y={372} a={90} className="hiw-fm" />
              <line x1={194} y1={444} x2={194} y2={478} className="hiw-line" strokeWidth={1.8} strokeOpacity={0.55} strokeDasharray="6 5" />
              <Arrow x={194} y={470} a={90} className="hiw-fm" />

              {/* cue */}
              <rect x={84} y={16} width={220} height={54} rx={11} className="hiw-card" />
              <rect x={84} y={16} width={220} height={54} rx={11} className="hiw-s-cue" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={94} y={23} width={120} height={4.5} rx={2.25} className="hiw-s-cue" />
              <text x={194} y={40} textAnchor="middle" fontSize={14.5} fontWeight={600} letterSpacing={1} className="hiw-t">CUE</text>
              <text x={194} y={58} textAnchor="middle" fontSize={10.5} className="hiw-tm">a bar sweeps across the eye</text>

              {/* kenyon */}
              <rect x={84} y={110} width={220} height={54} rx={11} className="hiw-card" />
              <rect x={84} y={110} width={220} height={54} rx={11} className="hiw-s-kenyon" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={94} y={117} width={120} height={4.5} rx={2.25} className="hiw-s-kenyon" />
              <text x={194} y={134} textAnchor="middle" fontSize={13} fontWeight={600} className="hiw-t">KENYON CODE</text>
              <text x={194} y={153} textAnchor="middle" fontSize={10.5} className="hiw-tm">sparse snapshot of “now”</text>

              {/* sugar / shock → dopamine → synapse */}
              <rect x={310} y={190} width={64} height={42} rx={9} fill={REGION_HEX.lobula} fillOpacity={0.15} className="hiw-eml" strokeWidth={1.5} />
              <text x={342} y={207} textAnchor="middle" fontSize={10.5} fontWeight={700} letterSpacing={0.5} className="hiw-emt">SUGAR</text>
              <text x={342} y={222} textAnchor="middle" fontSize={8.5} className="hiw-tm">reward</text>
              <rect x={310} y={252} width={64} height={42} rx={9} fill={ROSE} fillOpacity={0.15} className="hiw-rol" strokeWidth={1.5} />
              <text x={342} y={269} textAnchor="middle" fontSize={10.5} fontWeight={700} letterSpacing={0.5} className="hiw-rot">SHOCK</text>
              <text x={342} y={284} textAnchor="middle" fontSize={8.5} className="hiw-tm">punish</text>
              <text x={342} y={246} textAnchor="middle" fontSize={9} fontStyle="italic" className="hiw-tm">dopamine</text>
              <g aria-hidden="true">
                <path d="M 310 214 L 216 228" fill="none" className="hiw-eml hiw-anim hiw-dae" strokeWidth={2} strokeDasharray="5 4" />
                <Arrow x={216} y={228} a={171} s={0.85} className="hiw-emf" />
                <path d="M 310 272 L 216 243" fill="none" className="hiw-rol hiw-anim hiw-dar" strokeWidth={2} strokeDasharray="5 4" />
                <Arrow x={216} y={243} a={197} s={0.85} className="hiw-rof" />
              </g>
              <SynapseKnob x={194} y={236} r={12} />
              <text x={216} y={258} fontSize={9} fontStyle="italic" className="hiw-tm">K→M synapse</text>

              {/* formula */}
              <rect x={55} y={306} width={280} height={48} rx={10} className="hiw-card" />
              <rect x={55} y={306} width={280} height={48} rx={10} fill="none" className="hiw-line" strokeWidth={1.4} strokeDasharray="5 4" strokeOpacity={0.6} />
              <text x={195} y={323} textAnchor="middle" fontSize={9} letterSpacing={1.5} className="hiw-tm">THE 3-FACTOR LEARNING RULE</text>
              <text x={195} y={343} textAnchor="middle" fontSize={11.5} className="hiw-t font-mono">
                Δw = learningRate × <tspan className="hiw-emt">dopamine</tspan> × <tspan className="hiw-tet">elig.</tspan>
              </text>

              {/* MBON */}
              <rect x={84} y={380} width={220} height={64} rx={11} className="hiw-card" />
              <rect x={84} y={380} width={220} height={64} rx={11} className="hiw-s-mbon" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={94} y={387} width={58} height={4.5} rx={2.25} className="hiw-s-mbon" />
              <rect x={162} y={387} width={58} height={4.5} rx={2.25} className="hiw-s-shock" />
              <text x={194} y={406} textAnchor="middle" fontSize={14} fontWeight={600} className="hiw-t">MBONs</text>
              <rect x={125} y={416} width={70} height={16} rx={8} className="hiw-s-mbon" fillOpacity={0.16} strokeOpacity={0.5} strokeWidth={1} />
              <text x={160} y={427.5} textAnchor="middle" fontSize={9.5} className="hiw-emt" fontWeight={600}>approach</text>
              <rect x={205} y={416} width={56} height={16} rx={8} className="hiw-s-shock" fillOpacity={0.16} strokeOpacity={0.5} strokeWidth={1} />
              <text x={233} y={427.5} textAnchor="middle" fontSize={9.5} className="hiw-rot" fontWeight={600}>avoid</text>

              {/* behavior */}
              <rect x={84} y={478} width={220} height={54} rx={11} className="hiw-card" />
              <rect x={84} y={478} width={220} height={54} rx={11} className="hiw-s-beh" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={94} y={485} width={120} height={4.5} rx={2.25} className="hiw-s-beh" />
              <text x={194} y={503} textAnchor="middle" fontSize={13} fontWeight={600} className="hiw-t">BEHAVIOR</text>
              <text x={194} y={521} textAnchor="middle" fontSize={10.5} className="hiw-tm">jump · duck · steer</text>

              {/* orbiting loop dot (down the spine, back up the left rail) */}
              <g className="hiw-anim hiw-d2-dotm" aria-hidden="true">
                <circle r={9} fill={AMBER} opacity={0.22} />
                <circle r={4} fill={AMBER} />
              </g>
            </g>
          </svg>
        </div>

        {/* caption chips */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <span className="rounded-full border border-emerald-600/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-300">
            sugar strengthens recent wiring
          </span>
          <span className="rounded-full border border-rose-600/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-700 dark:text-rose-300">
            shock weakens it
          </span>
        </div>
        <figcaption className="mt-2 text-center text-xs text-muted-foreground">
          The loop closes — what the fly does changes what it sees next, and
          dopamine decides which synapses survive the moment.
        </figcaption>
      </figure>
    </DiagramShell>
  );
}

/* ============================================================================
 * DIAGRAM 3 — Evolution loop (population → judge → select → breed, gen +1)
 * ========================================================================== */

const D3_RING =
  "M 170 90 H 510 Q 560 90 560 140 V 300 Q 560 350 510 350 H 170 Q 120 350 120 300 V 140 Q 120 90 170 90 Z";
const D3_LOOP_M = "M 190 56 L 190 410 L 24 410 L 24 56 Z";

const EVOLUTION_STYLE = `
.hiw-diagram .hiw-t { fill: var(--foreground); }
.hiw-diagram .hiw-tm { fill: var(--muted-foreground); }
.hiw-diagram .hiw-card { fill: var(--card); }
.hiw-diagram .hiw-line { stroke: var(--muted-foreground); }
.hiw-diagram .hiw-fm { fill: var(--muted-foreground); }
.hiw-diagram .hiw-s-pop { stroke: #d97706; fill: #f59e0b; }
.hiw-diagram .hiw-s-judge { stroke: #0d9488; fill: #2dd4bf; }
.hiw-diagram .hiw-s-select { stroke: #059669; fill: #34d399; }
.hiw-diagram .hiw-s-breed { stroke: #be123c; fill: #fb7185; }
.dark .hiw-diagram .hiw-s-pop { stroke: #f59e0b; }
.dark .hiw-diagram .hiw-s-judge { stroke: #2dd4bf; }
.dark .hiw-diagram .hiw-s-select { stroke: #34d399; }
.dark .hiw-diagram .hiw-s-breed { stroke: #fb7185; }
.hiw-diagram .hiw-aml { stroke: #d97706; }
.dark .hiw-diagram .hiw-aml { stroke: #f59e0b; }
.hiw-diagram .hiw-amf { fill: #d97706; }
.dark .hiw-diagram .hiw-amf { fill: #f59e0b; }
.hiw-diagram .hiw-amt { fill: #b45309; }
.dark .hiw-diagram .hiw-amt { fill: #fbbf24; }
@keyframes hiw-d3-orbit { from { offset-distance: 0%; } to { offset-distance: 100%; } }
.hiw-diagram .hiw-d3-dotd { offset-path: path("${D3_RING}"); animation: hiw-d3-orbit 9s linear infinite; }
.hiw-diagram .hiw-d3-dotm { offset-path: path("${D3_LOOP_M}"); animation: hiw-d3-orbit 9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .hiw-diagram .hiw-anim { animation: none !important; }
}
`;

export function EvolutionLoopDiagram() {
  return (
    <DiagramShell label="Evolution loop diagram">
      <style>{EVOLUTION_STYLE}</style>
      <figure className="m-0">
        {/* ---- desktop: ring cycle ---- */}
        <div className="mx-auto hidden max-w-[620px] md:block">
          <svg
            viewBox="0 0 680 372"
            role="img"
            aria-label="Evolution loop: a population of 5 to 8 flies is judged by score, the top 2 elites are selected and cloned, the rest are bred by crossover and mutation, and the cycle repeats with the generation counter incrementing each lap."
            className="h-auto w-full"
          >
            <title>Evolution loop — judge, select, breed, generation +1</title>
            <g strokeLinecap="round" strokeLinejoin="round">
              <path d={D3_RING} fill="none" className="hiw-aml" strokeWidth={2} strokeOpacity={0.75} strokeDasharray="7 5" />
              <Arrow x={340} y={90} className="hiw-amf" />
              <Arrow x={560} y={220} a={90} className="hiw-amf" />
              <Arrow x={340} y={350} a={180} className="hiw-amf" />
              <Arrow x={120} y={220} a={270} className="hiw-amf" />

              {/* population */}
              <rect x={60} y={100} width={220} height={80} rx={12} className="hiw-card" />
              <rect x={60} y={100} width={220} height={80} rx={12} className="hiw-s-pop" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={74} y={107} width={192} height={4.5} rx={2.25} className="hiw-s-pop" />
              <text x={170} y={133} textAnchor="middle" fontSize={14.5} fontWeight={600} letterSpacing={0.5} className="hiw-t">POPULATION</text>
              <text x={170} y={152} textAnchor="middle" fontSize={11} className="hiw-tm">5–8 flies play the same world</text>
              <text x={170} y={169} textAnchor="middle" fontSize={10} fontStyle="italic" className="hiw-tm">as translucent ghosts</text>

              {/* judge */}
              <rect x={400} y={100} width={220} height={80} rx={12} className="hiw-card" />
              <rect x={400} y={100} width={220} height={80} rx={12} className="hiw-s-judge" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={414} y={107} width={192} height={4.5} rx={2.25} className="hiw-s-judge" />
              <text x={510} y={133} textAnchor="middle" fontSize={14.5} fontWeight={600} letterSpacing={0.5} className="hiw-t">JUDGE</text>
              <text x={510} y={152} textAnchor="middle" fontSize={11} className="hiw-tm">dino: obstacles cleared</text>
              <text x={510} y={169} textAnchor="middle" fontSize={11} className="hiw-tm">bicycle: metres ridden</text>

              {/* select */}
              <rect x={400} y={260} width={220} height={80} rx={12} className="hiw-card" />
              <rect x={400} y={260} width={220} height={80} rx={12} className="hiw-s-select" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={414} y={267} width={192} height={4.5} rx={2.25} className="hiw-s-select" />
              <text x={510} y={293} textAnchor="middle" fontSize={14.5} fontWeight={600} letterSpacing={0.5} className="hiw-t">SELECT</text>
              <text x={510} y={312} textAnchor="middle" fontSize={11} className="hiw-tm">top-2 elites cloned exactly</text>
              <text x={510} y={329} textAnchor="middle" fontSize={10} fontStyle="italic" className="hiw-tm">including what they learned</text>

              {/* breed */}
              <rect x={60} y={260} width={220} height={80} rx={12} className="hiw-card" />
              <rect x={60} y={260} width={220} height={80} rx={12} className="hiw-s-breed" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={74} y={267} width={192} height={4.5} rx={2.25} className="hiw-s-breed" />
              <text x={170} y={293} textAnchor="middle" fontSize={14.5} fontWeight={600} letterSpacing={0.5} className="hiw-t">BREED</text>
              <text x={170} y={312} textAnchor="middle" fontSize={11} className="hiw-tm">mix two parents&apos; wires</text>
              <text x={170} y={329} textAnchor="middle" fontSize={10} fontStyle="italic" className="hiw-tm">+ tiny random mutations</text>

              {/* generation counter */}
              <rect x={250} y={182} width={180} height={76} rx={14} fill={AMBER} fillOpacity={0.12} className="hiw-aml" strokeWidth={1.6} />
              <text x={340} y={216} textAnchor="middle" fontSize={19} fontWeight={700} className="hiw-amt">GEN +1</text>
              <text x={340} y={240} textAnchor="middle" fontSize={10.5} className="hiw-tm">each full lap of the loop</text>

              {/* orbiting dot */}
              <g className="hiw-anim hiw-d3-dotd" aria-hidden="true">
                <circle r={10} fill={AMBER} opacity={0.22} />
                <circle r={4.5} fill={AMBER} />
              </g>
            </g>
          </svg>
        </div>

        {/* ---- mobile: stacked cycle ---- */}
        <div className="mx-auto w-full max-w-[420px] md:hidden">
          <svg
            viewBox="0 0 380 575"
            role="img"
            aria-label="Evolution loop, stacked: population of 5 to 8 flies, judged by score, top-2 elites selected, rest bred with crossover and mutation, back to the population with generation +1."
            className="h-auto w-full"
          >
            <title>Evolution loop — stacked layout</title>
            <g strokeLinecap="round" strokeLinejoin="round">
              {/* loop-back rail */}
              <path d="M 60 410 H 24 V 56 H 56" fill="none" className="hiw-aml" strokeWidth={1.8} strokeDasharray="6 5" strokeOpacity={0.75} />
              <Arrow x={58} y={56} className="hiw-amf" />
              <text x={14} y={233} textAnchor="middle" fontSize={9.5} className="hiw-tm" transform="rotate(-90 14 233)">
                next generation
              </text>

              {[0, 1, 2, 3].map((i) => (
                <g key={i} aria-hidden="true">
                  <line x1={190} y1={16 + i * 118 + 80} x2={190} y2={16 + (i + 1) * 118} className="hiw-aml" strokeWidth={1.8} strokeDasharray="6 5" strokeOpacity={0.75} />
                  <Arrow x={190} y={16 + (i + 1) * 118 - 8} a={90} className="hiw-amf" />
                </g>
              ))}

              {/* population */}
              <rect x={60} y={16} width={260} height={80} rx={12} className="hiw-card" />
              <rect x={60} y={16} width={260} height={80} rx={12} className="hiw-s-pop" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={140} y={23} width={100} height={4.5} rx={2.25} className="hiw-s-pop" />
              <text x={190} y={43} textAnchor="middle" fontSize={14} fontWeight={600} letterSpacing={0.5} className="hiw-t">POPULATION</text>
              <text x={190} y={63} textAnchor="middle" fontSize={11} className="hiw-tm">5–8 flies play the same world</text>
              <text x={190} y={81} textAnchor="middle" fontSize={10} fontStyle="italic" className="hiw-tm">as translucent ghosts</text>

              {/* judge */}
              <rect x={60} y={134} width={260} height={80} rx={12} className="hiw-card" />
              <rect x={60} y={134} width={260} height={80} rx={12} className="hiw-s-judge" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={140} y={141} width={100} height={4.5} rx={2.25} className="hiw-s-judge" />
              <text x={190} y={161} textAnchor="middle" fontSize={14} fontWeight={600} letterSpacing={0.5} className="hiw-t">JUDGE</text>
              <text x={190} y={181} textAnchor="middle" fontSize={11} className="hiw-tm">dino: obstacles cleared</text>
              <text x={190} y={199} textAnchor="middle" fontSize={11} className="hiw-tm">bicycle: metres ridden</text>

              {/* select */}
              <rect x={60} y={252} width={260} height={80} rx={12} className="hiw-card" />
              <rect x={60} y={252} width={260} height={80} rx={12} className="hiw-s-select" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={140} y={259} width={100} height={4.5} rx={2.25} className="hiw-s-select" />
              <text x={190} y={279} textAnchor="middle" fontSize={14} fontWeight={600} letterSpacing={0.5} className="hiw-t">SELECT</text>
              <text x={190} y={299} textAnchor="middle" fontSize={11} className="hiw-tm">top-2 elites cloned exactly</text>
              <text x={190} y={317} textAnchor="middle" fontSize={10} fontStyle="italic" className="hiw-tm">including what they learned</text>

              {/* breed */}
              <rect x={60} y={370} width={260} height={80} rx={12} className="hiw-card" />
              <rect x={60} y={370} width={260} height={80} rx={12} className="hiw-s-breed" fillOpacity={0.1} strokeOpacity={0.8} strokeWidth={1.6} />
              <rect x={140} y={377} width={100} height={4.5} rx={2.25} className="hiw-s-breed" />
              <text x={190} y={397} textAnchor="middle" fontSize={14} fontWeight={600} letterSpacing={0.5} className="hiw-t">BREED</text>
              <text x={190} y={417} textAnchor="middle" fontSize={11} className="hiw-tm">mix two parents&apos; wires</text>
              <text x={190} y={435} textAnchor="middle" fontSize={10} fontStyle="italic" className="hiw-tm">+ tiny random mutations</text>

              {/* generation counter */}
              <rect x={95} y={490} width={190} height={64} rx={14} fill={AMBER} fillOpacity={0.12} className="hiw-aml" strokeWidth={1.6} />
              <text x={190} y={519} textAnchor="middle" fontSize={17} fontWeight={700} className="hiw-amt">GEN +1</text>
              <text x={190} y={541} textAnchor="middle" fontSize={10} className="hiw-tm">each full lap of the loop</text>

              {/* orbiting dot */}
              <g className="hiw-anim hiw-d3-dotm" aria-hidden="true">
                <circle r={9} fill={AMBER} opacity={0.22} />
                <circle r={4} fill={AMBER} />
              </g>
            </g>
          </svg>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <span className="rounded-full border border-amber-600/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
            dino: obstacles cleared
          </span>
          <span className="rounded-full border border-amber-600/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
            bicycle: metres ridden
          </span>
        </div>
        <figcaption className="mt-2 text-center text-xs text-muted-foreground">
          Both trainers run the same cycle — the amber dot is one generation
          turning over. Best &amp; average scores climb lap after lap.
        </figcaption>
      </figure>
    </DiagramShell>
  );
}
