import { memberName, newReply, type CaseRecords } from "@zireh/cases";
import type { Reply, ReplyStatus } from "@zireh/schema";
import { CalendarDots as CalendarClock, ChatTeardropText as MessageSquareReply, Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { save } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export const REPLY_STATUS: Record<ReplyStatus, string> = {
  "to-contact": "To contact",
  contacted: "Contacted, waiting",
  responded: "Responded",
  declined: "Declined to comment",
  "no-response": "No response by deadline",
};
export const replyOpen = (r: Reply) => r.status === "to-contact" || r.status === "contacted";
export const replyOverdue = (r: Reply) => replyOpen(r) && !!r.deadline && r.deadline < new Date().toISOString().slice(0, 10);

/** Everyone a finding is about gets the chance to respond before it is published. */
export function RightOfReply({ caseId, rec, me, compact }: { caseId: string; rec: CaseRecords; me: string; compact?: boolean }) {
  const [adding, setAdding] = useState(false);
  const sorted = [...rec.replies].sort((a, b) => Number(replyOpen(b)) - Number(replyOpen(a)) || (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));

  return (
    <div className="grid gap-3">
      {sorted.length === 0 && !adding && <p className="text-sm text-muted-foreground">Nobody yet. Add each person or organization a finding is about, and when you asked them.</p>}
      {sorted.length > 0 && (
        <ul className="grid gap-2">
          {sorted.map((r) => (
            <ReplyRow key={r.id} caseId={caseId} rec={rec} reply={r} compact={compact} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddReply caseId={caseId} rec={rec} me={me} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setAdding(true)}>
          <Plus /> Add someone
        </Button>
      )}
    </div>
  );
}

function ReplyRow({ caseId, rec, reply: r, compact }: { caseId: string; rec: CaseRecords; reply: Reply; compact?: boolean | undefined }) {
  const [responding, setResponding] = useState(false);
  const update = (patch: Partial<Reply>) =>
    void save(caseId, "replies", { ...r, ...patch, updatedAt: new Date().toISOString() }).catch((error: Error) => toast.error("Couldn't update", { description: error.message }));
  const about = rec.findings.filter((f) => r.findingIds.includes(f.id)).map((f) => f.statement).join(" · ") || "The whole story";
  const late = replyOverdue(r);

  return (
    <li className={cn("grid gap-2 rounded-xl border bg-card p-3", !replyOpen(r) && "bg-muted/30")} title={`Added by ${memberName(rec, r.createdBy)}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <MessageSquareReply className="size-4 text-muted-foreground" />
          {r.party}
        </span>
        <span className={cn("flex items-center gap-1 text-xs tabular-nums", late ? "font-medium text-destructive" : "text-muted-foreground")}>
          <CalendarClock className="size-3.5" />
          <input
            type="date"
            aria-label={`Reply deadline for ${r.party}`}
            value={r.deadline ?? ""}
            onChange={(e) => {
              const { deadline: _old, ...rest } = r;
              void save(caseId, "replies", { ...rest, ...(e.target.value ? { deadline: e.target.value } : {}), updatedAt: new Date().toISOString() }).catch((error: Error) => toast.error("Couldn't update", { description: error.message }));
            }}
            className="rounded bg-transparent px-1 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          />
          {late && "late"}
        </span>
        <Select value={r.status} onValueChange={(v) => update({ status: v as ReplyStatus })}>
          <SelectTrigger size="sm" className="ml-auto h-7 w-auto min-w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(REPLY_STATUS) as ReplyStatus[]).map((st) => (
              <SelectItem key={st} value={st} className="text-xs">
                {REPLY_STATUS[st]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!compact && <p className="truncate text-xs text-muted-foreground">About: {about}</p>}
      {r.response || responding || r.status === "responded" ? (
        <Textarea
          defaultValue={r.response}
          autoFocus={responding}
          onBlur={(e) => e.target.value !== r.response && update({ response: e.target.value, ...(e.target.value && replyOpen(r) ? { status: "responded" as const } : {}) })}
          placeholder="Their response, as given. Quote exactly."
          className="min-h-16 font-serif text-sm"
        />
      ) : (
        <button type="button" onClick={() => setResponding(true)} className="justify-self-start text-xs font-medium text-foreground/80 underline-offset-4 hover:underline">
          Add their response
        </button>
      )}
    </li>
  );
}

function AddReply({ caseId, rec, me, onDone }: { caseId: string; rec: CaseRecords; me: string; onDone: () => void }) {
  const [party, setParty] = useState("");
  const [findingId, setFindingId] = useState("");
  const [deadline, setDeadline] = useState("");
  return (
    <form
      className="grid gap-3 rounded-xl border bg-card p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await save(caseId, "replies", newReply(caseId, me, { party, findingIds: findingId ? [findingId] : [], ...(deadline ? { deadline } : {}) }));
          toast.success("Added to right of reply");
          onDone();
        } catch (error) {
          toast.error("Couldn't add", { description: (error as Error).message });
        }
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="ror-party" className="text-xs">
          Who
        </Label>
        <Input id="ror-party" required autoFocus maxLength={200} value={party} onChange={(e) => setParty(e.target.value)} placeholder="e.g. Larkspur Freight press office" className="h-8" />
      </div>
      <div className="flex flex-wrap gap-3">
        {rec.findings.length > 0 && (
          <div className="grid min-w-0 flex-1 gap-1">
            <Label className="text-xs">About</Label>
            <Select value={findingId} onValueChange={setFindingId}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="The whole story" />
              </SelectTrigger>
              <SelectContent>
                {rec.findings.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    <span className="block max-w-[60vw] truncate sm:max-w-64">{f.statement}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-1">
          <Label htmlFor="ror-deadline" className="text-xs">
            Reply by
          </Label>
          <Input id="ror-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="h-8 w-40" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!party.trim()}>
          <Plus /> Add
        </Button>
      </div>
    </form>
  );
}
