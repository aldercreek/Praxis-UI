"""Real Praxis service and Agent with a deterministic, offline model."""
import json
import os
from pathlib import Path
from threading import Event

from praxis_agent.agent import Agent
from praxis_agent.execution import current_handle
from praxis_agent.model import FunctionCall, ModelResponse
from praxis_agent.planning import RunState
from praxis_agent.service import __main__ as service
from praxis_agent.service.manager import SessionManager
from praxis_agent.sessions import SQLiteSessionStore
from praxis_agent.tools import create_default_registry


class Model:
    def create_response(self, items, tools, on_text_delta=None):
        users = [item for item in items if isinstance(item, dict) and item.get("role") == "user"]
        if users and "approval example" in str(users[-1].get("content")):
            call_id = "approval-example"
            result = next((item for item in reversed(items) if isinstance(item, dict)
                           and item.get("type") == "function_call_output" and item.get("call_id") == call_id), None)
            if result is None:
                command = "echo praxis-approval"
                if "long" in str(users[-1].get("content")):
                    command += "-" + "visible-command-" * 12
                arguments = json.dumps({"command": command})
                call = FunctionCall(call_id, "run_command", arguments)
                return ModelResponse(({"type": "function_call", "call_id": call_id,
                                       "name": call.name, "arguments": arguments},), "", (call,))
            output = result["output"]
            # The context manager prefixes model-visible tool results with an ID.
            if output.startswith("[message_id="):
                output = output.split("\n", 1)[1]
            succeeded = json.loads(output)["success"]
            text = "Command approved and completed." if succeeded else "Command rejected without execution."
            if on_text_delta:
                on_text_delta(text)
            return ModelResponse(({"role": "assistant", "content": text},), text, ())
        if users and "hold this turn" in str(users[-1].get("content")):
            release = Event()
            handle = current_handle()
            unsubscribe = handle.on_cancel(release.set)
            try:
                if not release.wait(60):
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


if os.environ.get("PRAXIS_TEST_SEED_HISTORY") == "1":
    directory = Path(os.environ["PRAXIS_DATA_DIR"])
    store = SQLiteSessionStore(directory / "state.sqlite3")
    for name in ("alpha", "beta"):
        workspace = directory.parent / name
        workspace.mkdir()
        (workspace / "notes.md").write_text(f"# Notes from {name}\n", encoding="utf-8")
        sid = store.create_session(workspace, "offline").id
        state = RunState(f"Saved question {name}")
        store.start_run(sid, name, state, {"role": "user", "content": state.original_task})
        store.append_response_items(sid, name, [
            {"type": "function_call", "call_id": f"read-{name}", "name": "read_file", "arguments": '{"relative_path":"notes.md"}'},
            {"type": "function_call_output", "call_id": f"read-{name}", "output": json.dumps({"success": True, "output": f"Saved tool result {name}"})},
            {"role": "assistant", "content": f"Saved answer {name}. [Notes](notes.md)"},
        ])
        state.complete()
        store.finish_run(sid, name, state)

service.SessionManager = lambda store, **options: SessionManager(store, agent_factory=factory, **options)
service.main()
