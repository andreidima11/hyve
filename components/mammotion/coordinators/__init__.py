"""Mammotion device coordinators (HA-style report / map / errors split)."""

from components.mammotion.coordinators.errors import ErrorCoordinator
from components.mammotion.coordinators.map import MapCoordinator
from components.mammotion.coordinators.report import ReportCoordinator

__all__ = ["ErrorCoordinator", "MapCoordinator", "ReportCoordinator"]
