"""Provider registration. Extensions register implementations, not HTTP routes."""

import importlib
import os
from dataclasses import dataclass, field

from .domain import DomainError
from .fleet import HybridEphemeris
from .scheduling import DeadlineScheduler, GreedyScheduler


@dataclass
class Providers:
    schedulers: dict = field(default_factory=dict)
    ephemerides: dict = field(default_factory=dict)

    def scheduler(self, name):
        if name not in self.schedulers:
            raise DomainError(f"Unknown scheduler: {name}")
        return self.schedulers[name]

    def ephemeris(self, name):
        if name not in self.ephemerides:
            raise DomainError(f"Unknown ephemeris provider: {name}")
        return self.ephemerides[name]

    def describe(self):
        return dict(
            schedulers=sorted(self.schedulers),
            ephemeris_providers=sorted(self.ephemerides),
            units=dict(
                position="ECEF meters",
                time="UTC / seconds from scenario start",
                energy="Wh per spacecraft",
                data="MB per spacecraft",
            ),
            resource_model="Initial budgets minus collection costs; no recharge, downlink, slew, or bus power model.",
        )


def load_providers():
    providers = Providers()
    for scheduler in (GreedyScheduler(), DeadlineScheduler()):
        providers.schedulers[scheduler.name] = scheduler
    providers.ephemerides["hybrid"] = HybridEphemeris()
    for module in filter(None, os.environ.get("ORBIT_PROVIDER_MODULES", "").split(",")):
        importlib.import_module(module.strip()).register(providers)
    return providers


def repository_factory(factory=None, options=None):
    path = factory or os.environ.get("ORBIT_REPOSITORY_FACTORY", "server.storage:SQLiteRepository")
    module, attribute = path.split(":", 1)
    return getattr(importlib.import_module(module), attribute)(**(options or {}))
