import { commentsOn, memberName, newComment } from "@zireh/cases";
import { ChatCircle as MessageSquare, PaperPlaneTilt as Send } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useDraft } from "../drafts.ts";
import { myMemberId, save, useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Discussion attached to one item, in a popover so it never pushes the page around. */
export function Comments({ caseId, targetId }: { caseId: string; targetId: string }) {
  const rec = useStore((s) => s.cases[caseId])!;
  const [text, setText, clearText] = useDraft(caseId, `comment.${targetId}`, "");
  const thread = commentsOn(rec, targetId);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
          <MessageSquare className="size-3.5" />
          {thread.length ? `${thread.length} comment${thread.length === 1 ? "" : "s"}` : "Comment"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-3 p-3">
        {thread.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments yet. Only your team can read them.</p>
        ) : (
          <ul className="grid max-h-64 gap-2.5 overflow-y-auto">
            {thread.map((c) => (
              <li key={c.id} className="grid gap-0.5 text-sm">
                <span className="text-xs font-medium">
                  {memberName(rec, c.memberId)} <span className="font-normal text-muted-foreground">· {new Date(c.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                </span>
                <span className="whitespace-pre-wrap">{c.text}</span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            try {
              await save(caseId, "comments", newComment(caseId, myMemberId(caseId), { targetId, text }));
              clearText();
            } catch (error) {
              toast.error("Couldn't post", { description: (error as Error).message });
            }
          }}
        >
          <Input aria-label="Write a comment" placeholder="Write a comment" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} className="h-8 text-sm" autoFocus />
          <Button type="submit" size="icon" className="size-8" disabled={!text.trim()} aria-label="Post comment">
            <Send />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
