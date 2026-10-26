import { ART, createRenderer, detectColorLevel, type Art, type BannerInfo, type ColorLevel } from "./cli-banner";

// Terminal motion for the CLI. Nothing is drawn unless the stream is an interactive terminal, so
// --json/--agent output, pipes and coding agents' shells stay plain; CI and NO_COLOR get still frames.
const ESC = "\x1b[";
const still = (stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv) => Boolean(env.CI) || detectColorLevel(env) === "none" || !stream.isTTY;

// The four lines draw in from the left; the orange marker lands on the last two frames.
export function markFrames(art: Art, size: string, steps = 8): Art[] {
  const rows = art.sizes[size], width = rows[0].length, start = Math.min(...rows.map((row) => row.indexOf("a")).filter((x) => x >= 0));
  return Array.from({ length: steps }, (_, i) => {
    const reach = start + Math.ceil(((width - start) * (i + 1)) / steps), marker = i >= steps - 2;
    return { ...art, sizes: { [size]: rows.map((row) => [...row].map((c, x) => (c === "b" ? (marker ? c : ".") : c === "." || x < reach ? c : ".")).join("")) } };
  });
}

export async function playBanner(info: BannerInfo, options: { size?: "compact" | "large"; stream?: NodeJS.WriteStream; env?: NodeJS.ProcessEnv; frameMs?: number } = {}) {
  const stream = options.stream ?? process.stdout, env = options.env ?? process.env, size = options.size ?? "large";
  if (!stream.isTTY) return;
  const color: ColorLevel = detectColorLevel(env), columns = stream.columns;
  if (still(stream, env)) { stream.write(`\n${createRenderer(ART).renderBanner(info, { size, color, columns })}\n\n`); return; }
  stream.write("\n");
  let height = 0;
  for (const frame of markFrames(ART, size)) {
    const lines = createRenderer(frame).renderBanner(info, { size, color, columns }).split("\n");
    if (height) stream.write(`${ESC}${height}A\r`);
    stream.write(lines.map((line) => `${line}${ESC}K`).join("\n") + "\n");
    height = lines.length;
    await new Promise((resolve) => setTimeout(resolve, options.frameMs ?? 45));
  }
  stream.write("\n");
}

// One status line while a review runs: a pulsing orange marker, the current stage and elapsed time.
export function stageReporter(stream: NodeJS.WriteStream = process.stderr, env: NodeJS.ProcessEnv = process.env) {
  if (still(stream, env)) return { stage: (name: string) => { stream.write(`${name.replaceAll("_", " ")}\n`); }, done: () => {} };
  const level = detectColorLevel(env), orange = level === "truecolor" ? "38;2;245;78;0" : level === "256" ? "38;5;202" : "33";
  const started = Date.now();
  let label = "starting", tick = 0;
  const draw = () => stream.write(`\r${ESC}K${ESC}${tick++ % 4 < 2 ? "1;" : "2;"}${orange}m●${ESC}0m ${label} ${ESC}2m${Math.round((Date.now() - started) / 1000)}s${ESC}0m`);
  const timer = setInterval(draw, 150);
  draw();
  return {
    stage(name: string) { label = name.replaceAll("_", " "); draw(); },
    done() { clearInterval(timer); stream.write(`\r${ESC}K`); },
  };
}
