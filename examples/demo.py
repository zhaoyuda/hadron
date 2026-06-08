"""Sample Python script for syntax highlighting demo. [auto-reload test v2]"""

import asyncio
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Agent:
    """Represents an AI agent in the workspace."""
    id: str
    name: str
    state: str = "idle"
    task: Optional[str] = None
    artifacts: list[str] = field(default_factory=list)

    @property
    def is_active(self) -> bool:
        return self.state in ("working", "blocked")

    def assign_task(self, task: str) -> None:
        self.task = task
        self.state = "working"


async def monitor_agents(agents: list[Agent]) -> None:
    """Poll agent states and report changes."""
    prev_states = {a.id: a.state for a in agents}

    while True:
        for agent in agents:
            if agent.state != prev_states[agent.id]:
                print(f"[{agent.name}] {prev_states[agent.id]} -> {agent.state}")
                prev_states[agent.id] = agent.state

                if agent.state == "blocked":
                    await notify_blocked(agent)

        await asyncio.sleep(2.0)


async def notify_blocked(agent: Agent) -> None:
    print(f"⚠ Agent {agent.name} is blocked: {agent.task}")


# Dictionary comprehension + f-strings
AGENT_COLORS = {
    state: f"\033[{code}m"
    for state, code in [
        ("idle", 37),
        ("working", 34),
        ("done", 32),
        ("blocked", 31),
    ]
}

def summary(agents: list[Agent]) -> str:
    active = sum(1 for a in agents if a.is_active)
    blocked = sum(1 for a in agents if a.state == "blocked")
    return f"Total: {len(agents)} | Active: {active} | Blocked: {blocked}"


if __name__ == "__main__":
    agents = [
        Agent("web", "web", task="Implement markdown preview"),
        Agent("api", "api", state="working", task="Build Python highlighter"),
        Agent("ghostfolio", "Ghostfolio", state="blocked", task="Fix deploy"),
        Agent("hadron", "Hadron", state="working", task="Live file reload"),
    ]
    print(summary(agents))
    asyncio.run(monitor_agents(agents))
