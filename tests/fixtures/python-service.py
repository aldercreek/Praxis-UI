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
from praxis_agent.multi_agent.tools import register_parent_tools, register_worker_tools
from praxis_agent.planning import RunState
from praxis_agent.service import __main__ as service
from praxis_agent.service.manager import SessionManager
from praxis_agent.service.collaboration import collaboration_messages
from praxis_agent.sessions import SQLiteSessionStore
from praxis_agent.tools import create_default_registry


class Model:
    def __init__(self, agent_id=None):
        self.agent_id = agent_id

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

    @staticmethod
    def reports(items):
        reports = []
        for item in items:
            if isinstance(item, dict) and item.get('role') == 'user' and isinstance(item.get('content'), str):
                text = re.sub(r'^\[message_id=[^\]]+\]\s*', '', item['content'])
                reports.extend(collaboration_messages(text) or [])
        return reports

    @staticmethod
    def team(items):
        for item in reversed(items):
            text = str(item.get('content', '')) if isinstance(item, dict) else ''
            if '<collaboration_status>' in text:
                return json.loads(text.splitlines()[-2])
        raise AssertionError('Missing current team context')

    def wait(self, items, prefix='wait-workers'):
        number = 1
        while self.result(items, f'{prefix}-{number}') is not None:
            number += 1
        return self.calls((f'{prefix}-{number}', 'wait_agents', {'timeout': 60}))

    def create_response(self, items, tools, on_text_delta=None):
        users = [item for item in items if isinstance(item, dict) and item.get("role") == "user"]
        if self.agent_id:
            if self.result(items, 'worker-read') is None:
                return self.calls(('worker-read', 'read_file', {'relative_path': 'notes.md'}))
            text = 'Worker review complete.\n\n- Queue order preserved\n- History checked'
            if any('Exchange peer findings' in str(item.get('content')) for item in users):
                peer = next((agent for agent in self.team(items) if agent['agent_id'] != self.agent_id), None)
                if peer is None:
                    return self.wait(items, 'wait-peer')
                if self.result(items, 'peer-send') is None:
                    own = next(agent for agent in self.team(items) if agent['agent_id'] == self.agent_id)
                    return self.calls(('peer-send', 'send_message', {
                        'target': peer['agent_id'], 'content': f"{own['task']} findings: recorded checks passed."
                    }))
                if not any(report['sender_id'] == peer['agent_id'] for report in self.reports(items)):
                    return self.wait(items, 'wait-peer')
                text = 'Peer exchange complete. Both sets of findings were received.'
            elif any('Verify peer exchange' in str(item.get('content')) for item in users):
                text = 'Replacement verification complete.'
            if on_text_delta:
                on_text_delta(text)
            return ModelResponse(({'role': 'assistant', 'content': text},), text, ())
        peer_example = any('agent collaboration example' in str(item.get('content')) for item in users)
        if peer_example or any('agent sidebar example' in str(item.get('content')) for item in users):
            if self.result(items, 'agent-plan') is None:
                return self.calls(('agent-plan', 'update_plan', {'plan': [
                    {'step': 'Review the recorded checks with agents', 'status': 'in_progress'},
                    {'step': 'Collect both reports', 'status': 'pending'},
                ]}))
            spawned = [self.result(items, key) for key in ('spawn-queue', 'spawn-history')]
            if any(result is None for result in spawned):
                task = 'Exchange peer findings about recorded checks in notes.md.' if peer_example else 'Read notes.md and review the recorded checks.'
                return self.calls(*[(key, 'spawn_agent', {'task': task, 'inherit_context': False,
                    'task_summary': title, 'working_directory': '.'}) for key, title in
                    [('spawn-queue', 'Queue review'), ('spawn-history', 'History review')]])
            ids = [json.loads(result['output'])['agent_id'] for result in spawned]
            delivered = {report['sender_id'] for report in self.reports(items) if report['content'].startswith('[Worker run ended;')}
            # A wake is only an input notification. Inspect reports and fresh
            # team state instead of assuming that every worker has finished.
            if not set(ids) <= delivered or any(worker['status'] not in ('idle', 'closed') for worker in self.team(items)):
                return self.wait(items)
            if peer_example:
                if self.result(items, 'close-history') is None:
                    return self.calls(('close-history', 'close_agent', {'agent_id': ids[1]}))
                verifier = self.result(items, 'spawn-verifier')
                if verifier is None:
                    return self.calls(('spawn-verifier', 'spawn_agent', {'task': 'Verify peer exchange using notes.md.',
                        'task_summary': 'Replacement verifier', 'working_directory': '.', 'inherit_context': True}))
                if json.loads(verifier['output'])['agent_id'] not in delivered:
                    return self.wait(items)
            if self.result(items, 'agent-plan-complete') is None:
                return self.calls(('agent-plan-complete', 'update_plan', {'plan': [
                    {'step': 'Review the recorded checks with agents', 'status': 'completed'},
                    {'step': 'Collect both reports', 'status': 'completed'},
                ]}))
            text = 'Peer exchange and replacement verification complete.' if peer_example else 'Both agent reports are available in the agent strip.'
            if on_text_delta:
                on_text_delta(text)
            return ModelResponse(({'role': 'assistant', 'content': text},), text, ())
        if any('agent input wait example' in str(item.get('content')) for item in users):
            result = self.result(items, 'wait-user')
            if result is None:
                return self.calls(('wait-user', 'wait_agents', {'timeout': 60}))
            assert json.loads(result['output'])['reason'] == 'user_input'
            text = 'User input received during agent wait.'
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
        registry = create_default_registry()
        register_worker_tools(registry, runtime, agent_id)
        return Agent(Model(agent_id), registry, runtime.handles[agent_id].workspace,
                     name=agent_id, execution_control=control, event_sink=sink,
                     receive_messages=lambda accept: runtime.receive(agent_id, accept),
                     team_context=lambda: runtime.context_item(agent_id),
                     bypass_approvals=agent.bypass_approvals,
                     approve_tool_call=lambda name, arguments: runtime.request_approval(agent_id, name, arguments))

    runtime = AgentRuntime(worker, MultiAgentConfig(max_workers=2), workspace=workspace,
                           approve_tool_call=options['approve_tool_call'], live_output_sink=options['event_sink'])
    agent.collaboration = runtime
    agent.receive_messages = lambda accept: runtime.receive('parent', accept)
    register_parent_tools(agent.tool_registry, runtime, agent._pump_worker_events,
                          has_user_input=agent._has_pending_user_input)
    agent.restore_history(store.load_conversation_items(session_id))
    return agent


if os.environ.get("PRAXIS_TEST_SEED_HISTORY") == "1":
    directory = Path(os.environ["PRAXIS_DATA_DIR"])
    store = SQLiteSessionStore(directory / "state.sqlite3")
    from praxis_agent.service.store import ServiceStore
    journal = ServiceStore(store)
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
        for event, data in [
            ("TurnStarted", {"task": state.original_task}),
            ("ToolCallPrepared", {"call_id": f"read-{name}", "tool_name": "read_file", "arguments": {"relative_path": "notes.md"}, "requires_approval": False}),
            ("ToolFinished", {"call_id": f"read-{name}", "result": {"success": True, "output": f"Saved tool result {name}"}}),
            ("AssistantTextCompleted", {"text": f"Saved answer {name}. [Notes](notes.md)"}),
            ("TurnCompleted", {}),
        ]:
            journal.append_event(sid, event, name, data=data)

service.SessionManager = lambda store, **options: SessionManager(store, agent_factory=factory, **options)
service.main()
