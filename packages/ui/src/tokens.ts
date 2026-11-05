export const tokens = {
  page: "rgb(246,246,243)",
  surface: "rgb(237,237,232)",
  surfaceDeep: "rgb(219,219,210)",
  card: "#ffffff",
  ink: "rgb(41,41,41)",
  body: "rgb(53,53,53)",
  btn: "rgb(25,25,25)",
  green: "rgb(76,192,43)",
  pill: "#EDF2F4",
  black: "#101010",
  radius: { card: 24, chip: 12, btn: 14 },
  font: {
    brand: "'Inter Variable', 'Inter', system-ui, sans-serif",
    body: "'Inter Variable', 'Inter', system-ui, sans-serif",
  },
} as const;
export type Tokens = typeof tokens;

export const motion = {
  enter: 200,
  exit: 100,
  expand: 160,
  hover: 200,
  grow: 200,
  glide: 180,
  drop: 300,
  timerTick: 100,
  loop: {
    caret: 800,
    pulse: 1000,
    pulseSoft: 2000,
    pulseQuick: 850,
    ping: 1500,
    jiggle: 800,
    blink: 4000,
    ants: 2000,
    ring: 3000,
    ringSlow: 5000,
    shimmer: 2500,
  },
  ease: {
    enter: "ease",
    exit: "ease-out",
    expand: "ease-out",
    hover: "ease",
    grow: "ease",
    glide: "cubic-bezier(0.2, 0, 0, 1)",
  },
} as const;
export type Motion = typeof motion;
