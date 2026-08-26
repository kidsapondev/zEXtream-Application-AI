from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from local_coder.protocols import AgentRun


@dataclass(frozen=True, slots=True)
class HistoryEntry:
    run: AgentRun
    started_at: datetime
    duration_s: float


class RunHistory:
    def __init__(self, limit: int = 50) -> None:
        self.limit = limit
        self.entries: list[HistoryEntry] = []

    def record(self, run: AgentRun, *, started_at: datetime, duration_s: float) -> HistoryEntry:
        entry = HistoryEntry(run=run, started_at=started_at, duration_s=duration_s)
        self.entries.append(entry)
        if len(self.entries) > self.limit:
            self.entries.pop(0)
        return entry

    def __len__(self) -> int:
        return len(self.entries)

    def __iter__(self):
        for entry in reversed(self.entries):
            yield entry

    def latest(self) -> HistoryEntry | None:
        return self.entries[-1] if self.entries else None

    @property
    def succeeded(self) -> int:
        return sum(1 for entry in self.entries if entry.run.succeeded)

    @property
    def failed(self) -> int:
        return sum(1 for entry in self.entries if not entry.run.succeeded)

    def touched_files(self) -> tuple[str, ...]:
        seen = set()
        result = []
        for entry in reversed(self.entries):
            for file in entry.run.touched_files:
                if file not in seen:
                    seen.add(file)
                    result.append(file)
        return tuple(result)

    def clear(self) -> None:
        self.entries.clear()
