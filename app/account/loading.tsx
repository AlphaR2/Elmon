import { ListSkeleton, PageHeaderSkeleton } from "../components/skeletons";

export default function Loading() {
  return (
    <div className="max-w-md space-y-4">
      <PageHeaderSkeleton />
      <ListSkeleton rows={3} />
    </div>
  );
}
