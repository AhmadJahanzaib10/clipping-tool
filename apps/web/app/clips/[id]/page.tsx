import { notFound } from "next/navigation";
import { ClipEditor } from "@/components/ClipEditor";
import { clipDetail } from "@/lib/clip-detail";

export const dynamic = "force-dynamic";

/** SPEC §11 clip review / editor. */
export default async function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const d = clipDetail((await params).id);
  if (!d || !d.clip.edit) notFound();
  return <ClipEditor d={d} />;
}
