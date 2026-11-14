"""Deep Agents research chat backed by MongoDB Atlas checkpoints."""
from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path

from dotenv import dotenv_values
from flask import Blueprint, jsonify, request

from sdow.wikipath import PathFinder, WikiError


class ResearchError(Exception):
  def __init__(self, message, status=400, code='invalid_request'):
    super().__init__(message)
    self.message, self.status, self.code = message, status, code


class ResearchService:
  """Create the agent lazily so the existing app works without Atlas credentials."""

  def __init__(self):
    self.lock = threading.Lock()
    self.agent = None
    self.client = None
    self.finder = PathFinder(max_requests=40, seconds=12, workers=2)

  @staticmethod
  def config():
    values = dotenv_values(Path(__file__).with_name('.env.local'))
    return {
        'api_key': os.environ.get('GEMINI_API_KEY') or values.get('GEMINI_API_KEY') or '',
        'model': os.environ.get('GEMINI_AGENT_MODEL') or values.get('GEMINI_AGENT_MODEL') or
                 os.environ.get('GEMINI_MODEL') or values.get('GEMINI_MODEL') or
                 'gemini-3.1-flash-lite',
        'mongo_uri': os.environ.get('MONGODB_URI') or values.get('MONGODB_URI') or '',
        'database': os.environ.get('MONGODB_DATABASE') or values.get('MONGODB_DATABASE') or
                    'wikiwormhole',
    }

  def get_agent(self):
    with self.lock:
      if self.agent is not None:
        return self.agent
      config = self.config()
      if not config['api_key']:
        raise ResearchError('Add GEMINI_API_KEY to backend sdow/.env.local.', 503,
                            'missing_model_key')
      if not config['mongo_uri']:
        raise ResearchError('Add MONGODB_URI to backend sdow/.env.local to enable research chat.',
                            503, 'missing_database')

      try:
        from deepagents import create_deep_agent
        from langchain_core.tools import tool
        from langchain_google_genai import ChatGoogleGenerativeAI
        from langgraph.checkpoint.mongodb import MongoDBSaver
        from pymongo import MongoClient
      except ImportError:
        raise ResearchError('Research dependencies are not installed. Install requirements.txt.',
                            503, 'missing_dependencies') from None

      @tool
      def find_wikipedia_connections(source: str, target: str) -> dict:
        """Find verified live Wikipedia link paths and shared topics between article titles."""
        try:
          return self.finder.connect(source, target)
        except WikiError as error:
          return {'status': error.code, 'message': error.message}
        except (ValueError, TypeError):
          return {'status': 'invalid_title', 'message': 'Provide two valid Wikipedia article titles.'}

      @tool
      def search_wikipedia_articles(query: str) -> list[dict]:
        """Find candidate English Wikipedia article titles for a short query."""
        return self.finder.resolve(query)

      self.client = MongoClient(config['mongo_uri'], serverSelectionTimeoutMS=5000,
                                connectTimeoutMS=5000)
      try:
        self.client.admin.command('ping')
        checkpointer = MongoDBSaver(self.client, db_name=config['database'])
        model = ChatGoogleGenerativeAI(model=config['model'], google_api_key=config['api_key'],
                                       temperature=0.2, timeout=35, max_retries=1)
        researcher = {
            'name': 'wikipedia-researcher',
            'description': 'Research Wikipedia articles and verify paths and shared topics.',
            'model': model,
            'system_prompt': ('Use the Wikipedia tools to verify article matches and link paths. '
                              'Report bounded or incomplete results accurately.'),
            'tools': [find_wikipedia_connections, search_wikipedia_articles],
        }
        self.agent = create_deep_agent(
            model=model,
            tools=[find_wikipedia_connections, search_wikipedia_articles],
            subagents=[researcher],
            checkpointer=checkpointer,
            system_prompt=(
                'You are the WikiWormhole research assistant. Help users explore connections '
                'between Wikipedia topics. Use the Wikipedia tools for claims about article '
                'titles, hyperlinks, paths, and shared topics. Never invent a path or claim a '
                'bounded search was exhaustive. Explain when a result is a shared topic rather '
                'than a directed link path. Keep answers readable and cite article titles as '
                'Markdown links when the tool returns their URLs.'),
        )
      except ResearchError:
        raise
      except Exception:
        self.client.close()
        self.client = None
        raise ResearchError('Could not connect to MongoDB Atlas or initialize research. Check '
                            'the Atlas URI, network access list, and database user.', 503,
                            'research_unavailable') from None
      return self.agent

  def chat(self, thread_id, message):
    if not isinstance(thread_id, str) or not re.fullmatch(r'[0-9a-f-]{36}', thread_id):
      raise ResearchError('Start a new research thread before sending a message.')
    if not isinstance(message, str) or not message.strip() or len(message) > 2000:
      raise ResearchError('Enter a message between 1 and 2000 characters.')
    agent = self.get_agent()
    try:
      result = agent.invoke(
          {'messages': [{'role': 'user', 'content': message.strip()}]},
          config={'configurable': {'thread_id': thread_id}},
      )
    except Exception:
      raise ResearchError('The research request failed. Check your model quota and try again.',
                          502, 'agent_error') from None
    answer = result['messages'][-1].content
    if isinstance(answer, list):
      answer = '\n'.join(block.get('text', '') for block in answer
                         if isinstance(block, dict) and block.get('type') == 'text')
    return str(answer)

  def history(self, thread_id):
    if not isinstance(thread_id, str) or not re.fullmatch(r'[0-9a-f-]{36}', thread_id):
      raise ResearchError('This research thread ID is invalid.')
    agent = self.get_agent()
    try:
      snapshot = agent.get_state({'configurable': {'thread_id': thread_id}})
    except Exception:
      raise ResearchError('Could not load this research thread.', 502, 'history_error') from None
    history = []
    for message in snapshot.values.get('messages', []):
      role = getattr(message, 'type', '')
      if role not in ('human', 'ai'):
        continue
      content = message.content
      if isinstance(content, list):
        content = '\n'.join(block.get('text', '') for block in content
                            if isinstance(block, dict) and block.get('type') == 'text')
      if isinstance(content, str) and content.strip():
        history.append({'role': 'user' if role == 'human' else 'assistant', 'text': content})
    return history


def create_blueprint(service=None):
  service = service or ResearchService()
  bp = Blueprint('research', __name__, url_prefix='/research')

  @bp.before_request
  def local_only():
    if request.remote_addr not in ('127.0.0.1', '::1') or request.headers.get('Origin') not in (
        None, 'http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:5001'):
      raise ResearchError('Research chat is available only from the local development page.', 403,
                          'local_only')
    request.max_content_length = 10_000

  @bp.errorhandler(ResearchError)
  def error_response(error):
    return jsonify(error=error.message, code=error.code), error.status

  @bp.get('/status')
  def status():
    config = service.config()
    return jsonify(available=bool(config['api_key'] and config['mongo_uri']),
                   model=config['model'], persistence='MongoDB Atlas')

  @bp.post('/threads')
  def create_thread():
    return jsonify(threadId=str(uuid.uuid4()))

  @bp.post('/chat')
  def chat():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
      raise ResearchError('Send a JSON object with threadId and message.')
    answer = service.chat(data.get('threadId'), data.get('message'))
    return jsonify(threadId=data['threadId'], answer=answer)

  @bp.get('/threads/<thread_id>')
  def history():
    return jsonify(threadId=thread_id, messages=service.history(thread_id))

  return bp
