"""Real Praxis service and Agent with a deterministic, offline model."""
from threading import Event

from praxis_agent.agent import Agent
from praxis_agent.execution import current_handle
from praxis_agent.model import ModelResponse
from praxis_agent.service import __main__ as service
from praxis_agent.service.manager import SessionManager
from praxis_agent.tools import create_default_registry


class Model:
    def create_response(self, items, tools, on_text_delta=None):
        users = [item for item in items if isinstance(item, dict) and item.get("role") == "user"]
        if users and "hold this turn" in str(users[-1].get("content")):
            release = Event()
            handle = current_handle()
            unsubscribe = handle.on_cancel(release.set)
            try:
                if not release.wait(20):
                    raise TimeoutError("Integration test did not cancel the turn")
                handle.check()
            finally:
                unsubscribe()
        if on_text_delta:
            on_text_delta("offline response")
        return ModelResponse(({"role": "assistant", "content": "offline response"},), "offline response", ())


def factory(workspace, **options):
    store, session_id = options["session_store"], options["resume_session_id"]
    agent = Agent(Model(), create_default_registry(), workspace,
                  event_sink=options["event_sink"], approve_tool_call=options["approve_tool_call"],
                  bypass_approvals=options["bypass_approvals"], session_store=store,
                  session_id=session_id, session_model="offline")
    agent.restore_history(store.load_conversation_items(session_id))
    return agent


service.SessionManager = lambda store: SessionManager(store, agent_factory=factory)
service.main()
