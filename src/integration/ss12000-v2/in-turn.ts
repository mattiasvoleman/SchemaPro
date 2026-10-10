/**
 * Runs the steps one after another and returns their results in order: a
 * transaction is one connection, and a statement sent while another runs on
 * it is queued by pg — deprecated, and refused from pg 9 on. The provider's
 * reads therefore never use Promise.all inside a transaction.
 */
export async function inTurn<T extends readonly unknown[]>(...steps: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
  const out: unknown[] = [];
  for (const step of steps) out.push(await step());
  return out as unknown as T;
}
