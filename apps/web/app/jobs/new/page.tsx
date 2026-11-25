import { eq } from "drizzle-orm";
import { schema } from "@clip/shared/db";
import { NewJobForm } from "@/components/NewJobForm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function NewJobPage() {
  const db = getDb();
  const campaigns = db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.active, true)).all();
  const operators = db.select({ id: schema.operators.id, name: schema.operators.name }).from(schema.operators).where(eq(schema.operators.active, true)).all();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">New job</h1>
      {campaigns.length === 0 || operators.length === 0 ? (
        <p className="text-sm text-zinc-500">Add at least one campaign and one operator first (`pnpm db:seed` creates examples).</p>
      ) : (
        <NewJobForm campaigns={campaigns} operators={operators} />
      )}
    </div>
  );
}
