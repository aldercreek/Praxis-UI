"""Real Praxis service and Agent with a deterministic, offline model."""
import json
import os
import re
from pathlib import Path
from threading import Event

from praxis_agent.agent import Agent
from praxis_agent.execution import current_handle
from praxis_agent.model import FunctionCall, ModelResponse
from praxis_agent.multi_agent.models import MultiAgentConfig
from praxis_agent.multi_agent.runtime import AgentRuntime
from praxis_agent.multi_agent.tools import register_parent_tools
from praxis_agent.planning import RunState
from praxis_agent.service import __main__ as service
from praxis_agent.service.manager import SessionManager
from praxis_agent.sessions import SQLiteSessionStore
from praxis_agent.tools import create_default_registry


class Model:
    def __init__(self, worker=False):
        self.worker = worker

    @staticmethod
    def result(items, call_id):
        item = next((item for item in reversed(items) if isinstance(item, dict)
                     and item.get('type') == 'function_call_output' and item.get('call_id') == call_id), None)
        if item is None:
            return None
        return json.loads(re.sub(r'^\[message_id=[^\]]+\]\s*', '', item['output']))

    @staticmethod
    def calls(*specs):
        calls = tuple(FunctionCall(call_id, name, json.dumps(arguments)) for call_id, name, arguments in specs)
        return ModelResponse(tuple({'type': 'function_call', 'call_id': call.call_id, 'name': call.name,
                                    'arguments': call.arguments} for call in calls), '', calls)

    def create_response(self, items, tools, on_text_delta=None):
        users = [item for item in items if isinstance(item, dict) and item.get("role") == "user"]
        if self.worker:
            if self.result(items, 'worker-read') is None:
                return self.calls(('worker-read', 'read_file', {'relative_path': 'notes.md'}))
            text = 'Worker review complete.\n\n- Queue order preserved\n- History checked'
            if on_text_delta:
                on_text_delta(text)
            return ModelResponse(({'role': 'assistant', 'content': text},), text, ())
        if any('agent sidebar example' in str(item.get('content')) for item in users):
            if self.result(items, 'agent-plan') is None:
                return self.calls(('agent-plan', 'update_plan', {'plan': [
                    {'step': 'Review the recorded checks with agents', 'status': 'in_progress'},
                    {'step': 'Collect both reports', 'status': 'pending'},
                ]}))
            spawned = [self.result(items, key) for key in ('spawn-queue', 'spawn-history')]
            if any(result is None for result in spawned):
                return self.calls(*[(key, 'spawn_agent', {'task': 'Read notes.md and review the recorded checks.',
                    'task_summary': title, 'working_directory': '.'}) for key, title in
                    [('spawn-queue', 'Queue review'), ('spawn-history', 'History review')]])
            wait_number = 1
            latest_wait = None
            while (result := self.result(items, f'wait-workers-{wait_number}')) is not None:
                latest_wait = json.loads(result['output'])
                wait_number += 1
            if latest_wait is None or any(worker['status'] not in ('idle', 'closed') for worker in latest_wait['agents']):
                ids = [json.loads(result['output'])['agent_id'] for result in spawned]
                return self.calls((f'wait-workers-{wait_number}', 'wait_agents', {'agent_ids': ids, 'timeout': 60}))
            if self.result(items, 'agent-plan-complete') is None:
                return self.calls(('agent-plan-complete', 'update_plan', {'plan': [
                    {'step': 'Review the recorded checks with agents', 'status': 'completed'},
                    {'step': 'Collect both reports', 'status': 'completed'},
                ]}))
            text = 'Both agent reports are available in the agent strip.'
            if on_text_delta:
                on_text_delta(text)
            return ModelResponse(({'role': 'assistant', 'content': text},), text, ())
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
    def worker(agent_id, control, sink):
        return Agent(Model(worker=True), create_default_registry(), runtime.handles[agent_id].workspace,
                     name=agent_id, execution_control=control, event_sink=sink,
                     receive_messages=lambda accept: runtime.receive(agent_id, accept),
                     bypass_approvals=agent.bypass_approvals,
                     approve_tool_call=lambda name, arguments: runtime.request_approval(agent_id, name, arguments))

    runtime = AgentRuntime(worker, MultiAgentConfig(max_workers=2), workspace=workspace,
                           approve_tool_call=options['approve_tool_call'], live_output_sink=options['event_sink'])
    agent.collaboration = runtime
    agent.receive_messages = lambda accept: runtime.receive('parent', accept)
    register_parent_tools(agent.tool_registry, runtime, agent._pump_worker_events)
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
