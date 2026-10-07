/**
 * Collision-resistant ids without external dependencies.
 *
 * A monotonic counter is mixed in so ids stay unique even when several are
 * minted inside the same millisecond (which happens when a template is applied).
 */
let counter = 0;

export function newId(prefix = "id"): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(3, "0");
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${time}${seq}${rand}`;
}
