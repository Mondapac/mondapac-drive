/** A field the request got wrong; never its value (identity design 5.2). */
export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}
