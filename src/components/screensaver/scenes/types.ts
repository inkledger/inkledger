/** The theme colours a scene paints with (CSS colour strings, read from the tokens at start). */
export type ScenePalette = {
  /** The paper behind the scene. */
  paper: string;
  /** The inks, the brand's first. */
  inks: readonly string[];
  dark: boolean;
};

export type SceneContext = {
  seed: number;
  /** Slow, near-still frames instead of motion (prefers-reduced-motion). */
  reducedMotion: boolean;
  palette: ScenePalette;
};

/** A procedural scene: draws into a canvas the host sizes, until `stop`. */
export type Scene = {
  id: string;
  start(canvas: HTMLCanvasElement, ctx: SceneContext): { stop(): void };
};
