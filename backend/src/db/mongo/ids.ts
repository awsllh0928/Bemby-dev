import type { Db } from "mongodb";

/**
 * Monotonic ids, the way SQLite's AUTOINCREMENT behaved.
 *
 * MongoDB's ObjectId is unique but not sortable within a collection in any order a human
 * or a "next account" cursor would recognise, and Bemby's primary keys are shown to the
 * operator and referenced in URLs. So ids stay small sequential integers, taken from a
 * counters collection with findOneAndUpdate + $inc -- the one operation that hands out a
 * new number atomically even when two requests ask at the same moment.
 */
export async function nextId(db: Db, collection: string): Promise<number> {
  const result = await db.collection<{ _id: string; seq: number }>("counters").findOneAndUpdate(
    { _id: collection },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return result?.seq ?? 1;
}

/**
 * Moves a counter past every id already in the collection.
 *
 * Needed after an import: rows brought over from SQLite carry their original ids, which the
 * counter knows nothing about, so the first insert afterwards would hand out id 1 and
 * collide with a row that already has it.
 */
export async function seedCounterAbove(
  db: Db,
  collection: string,
  maxId: number,
): Promise<void> {
  if (!maxId || maxId < 1) return;
  await db
    .collection<{ _id: string; seq: number }>("counters")
    .updateOne({ _id: collection }, { $max: { seq: maxId } }, { upsert: true });
}
