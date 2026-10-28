import type { PrivacyLevel } from "@zireh/schema";
import { useState } from "react";
import { createCase } from "../store.ts";
import { Dialog } from "./Dialog.tsx";
import { LEVEL_COPY } from "./levels.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function NewCaseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [name, setName] = useState("");
  const [privacy, setPrivacy] = useState<PrivacyLevel>("private");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  return (
    <Dialog title="Start a case" description="Only people you invite can read it." onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onCreated(await createCase({ title, question, privacy, memberName: name }));
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="nc-title">Case name</Label>
          <Input id="nc-title" required autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Port smuggling story" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="nc-question">What are you trying to find out?</Label>
          <Textarea id="nc-question" required maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} className="min-h-20 font-serif text-[15px]" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="nc-name">Your name in this case</Label>
          <Input id="nc-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="A pseudonym works" />
        </div>
        <div className="grid gap-1.5">
          <Label>Default privacy</Label>
          <ToggleGroup type="single" variant="outline" size="sm" value={privacy} onValueChange={(v) => v && setPrivacy(v as PrivacyLevel)} className="w-full">
            {(Object.keys(LEVEL_COPY) as PrivacyLevel[]).map((l) => (
              <ToggleGroupItem key={l} value={l} className="flex-1 text-xs">
                {LEVEL_COPY[l].name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">{LEVEL_COPY[privacy].note}</p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Start case
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
