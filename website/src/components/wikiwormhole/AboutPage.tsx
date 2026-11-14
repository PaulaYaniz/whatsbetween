import {Link} from 'react-router-dom';

import {Shell} from './Shell';

import './wikiwormhole.css';
import './about.css';

const tools = [
  {
    name: 'Google Gemini',
    url: 'https://ai.google.dev/',
    description:
      'Identifies objects in camera frames and photos, writes connection explanations, and powers research answers.',
  },
  {
    name: 'LangChain + Deep Agents',
    url: 'https://docs.langchain.com/oss/javascript/deepagents/overview',
    description:
      'Runs Dig deeper research with a controlled set of Wikipedia tools and an optional Wolfram Alpha calculation. The agent gathers evidence before composing an answer.',
  },
  {
    name: 'Wikipedia + MediaWiki API',
    url: 'https://www.mediawiki.org/wiki/API:Main_page',
    description:
      'Provides article matches, current text, outgoing links, and revision information. Source links let you read the underlying articles.',
  },
  {
    name: 'MongoDB Atlas',
    url: 'https://www.mongodb.com/atlas',
    description:
      'Stores saved investigations, source evidence, and finding versions when configured. Saved items belong to your anonymous browser session.',
  },
  {
    name: 'Wolfram Alpha',
    url: 'https://www.wolframalpha.com/',
    description:
      'An optional research tool for questions that need a calculation. It is only used when configured and requested by the research agent; ordinary answers do not require it.',
  },
  {
    name: 'React + React Router',
    url: 'https://react.dev/',
    description:
      'Builds the interface and handles navigation between Scan, discoveries, saved investigations, and this page.',
  },
  {
    name: 'Cloudflare Workers',
    url: 'https://developers.cloudflare.com/workers/',
    description:
      'Runs the TypeScript API that connects recognition, Wikipedia, research, and saved investigations. Wrangler and the Cloudflare Vite plugin support local preview and deployment.',
  },
  {
    name: 'Python + Flask + SQLite',
    url: 'https://github.com/jwngr/sdow',
    description:
      'Serves the downloaded SDOW link graph locally. The graph service finds shared topics and searches for shortest routes without fetching every link from Wikipedia.',
  },
];

export function AboutPage() {
  return (
    <Shell active="about">
      <title>About | What's Between</title>
      <main className="ww-main ww-about">
        <header className="ww-about-intro">
          <h1>
            Curiosity starts with
            <br />
            <span>what’s around you.</span>
          </h1>
          <p>
            What's Between connects two everyday objects through Wikipedia. Scan a pair, follow the
            links between their articles, and ask what’s behind the connection.
          </p>
          <Link className="ww-button ww-button--dark ww-about-start" to="/">
            Scan two objects
          </Link>
        </header>

        <section className="ww-about-section" aria-labelledby="about-how">
          <h2 id="about-how">From objects to ideas</h2>
          <ol className="ww-about-steps">
            <li>
              <h3>Recognize and choose</h3>
              <p>
                Open the camera or choose a photo. Gemini identifies objects, and the closest
                matching Wikipedia article is selected for each name. You can edit the names or
                choose a different article.
              </p>
            </li>
            <li>
              <h3>Follow the connections</h3>
              <p>
                The app looks for topics linked from both articles and searches for routes between
                them. When the local SDOW graph is available, it uses a dated Wikipedia snapshot;
                otherwise, live link searches have limits. The results show the graph date or search
                limits when available.
              </p>
            </li>
            <li>
              <h3>Read, question, explore</h3>
              <p>
                Gemini writes an explanation from retrieved Wikipedia passages. Open the evidence,
                try another shared topic, or use Dig deeper to choose a suggested question, ask your
                own, and continue with follow-ups.
              </p>
            </li>
          </ol>
        </section>

        <section className="ww-about-credit" aria-labelledby="about-sdow">
          <div>
            <h2 id="about-sdow">Built on Six Degrees of Wikipedia</h2>
            <p className="ww-about-credit-author">
              SDOW by Jacob Wenger
              <br />
              and its open-source contributors
            </p>
          </div>
          <div>
            <p>
              What's Between is built from the{' '}
              <a href="https://github.com/jwngr/sdow">Six Degrees of Wikipedia (SDOW)</a> codebase.
              Its Wikipedia link database and graph-search foundation make these connections
              possible. This project adds object recognition, a new interface, generated
              explanations, and conversational research.
            </p>
            <p>
              The local graph uses the December 20, 2023 snapshot. Current article passages are
              fetched separately, so today’s text can differ from the older link graph.
            </p>
            <p className="ww-about-credit-license">
              SDOW code: copyright © 2024 Jacob Wenger, released under the{' '}
              <a href="https://github.com/jwngr/sdow/blob/main/LICENSE">MIT License</a>. The
              original license notice is retained in this project.
            </p>
            <a className="ww-about-project-link" href="https://www.sixdegreesofwikipedia.com/">
              Visit the original Six Degrees of Wikipedia
            </a>
          </div>
        </section>

        <section className="ww-about-section" aria-labelledby="about-answers">
          <h2 id="about-answers">How answers are made</h2>
          <div className="ww-about-prose">
            <p>
              A shared link is a starting point for exploration. It does not establish a historical
              cause, scientific relationship, or a directed route between the two objects.
            </p>
            <p>
              Connection cards use retrieved article passages. Dig deeper uses LangChain’s{' '}
              <strong>Deep Agents</strong> framework with Gemini to search Wikipedia, read relevant
              article text, and attach source references to claims. Follow-up questions include
              recent conversation context; earlier answers are not treated as source evidence.
            </p>
            <p>
              Research records article revisions and retrieval times, and checks that cited evidence
              IDs belong to sources retrieved for that run. Answers can be marked as supported, a
              possible explanation, or needing more evidence. Generated explanations can still be
              wrong: use the linked sources to assess the claims.
            </p>
            <p>
              Each research run allows up to four model calls, eight external research requests, and
              one optional Wolfram Alpha calculation within 45 seconds. Source collection has a
              shorter deadline to leave time for an answer. If a source or model is unavailable, the
              conversation keeps the question and any retrieved sources so you can retry.
            </p>
          </div>
        </section>

        <section className="ww-about-section" aria-labelledby="about-tools">
          <h2 id="about-tools">The tools behind it</h2>
          <div>
            <dl className="ww-about-tools">
              {tools.map((tool) => (
                <div key={tool.name}>
                  <dt>
                    <a href={tool.url}>{tool.name}</a>
                  </dt>
                  <dd>{tool.description}</dd>
                </div>
              ))}
            </dl>
            <details className="ww-about-details">
              <summary>More building blocks and development credits</summary>
              <div>
                <p>
                  <strong>TypeScript, Vite, and Zod</strong> support the app build and validated API
                  inputs. Inherited SDOW components also use{' '}
                  <strong>D3, Lodash, styled-components, React Autosuggest, and React Modal</strong>
                  .
                </p>
                <p>
                  The interface uses <strong>Manrope, DM Sans, and DM Mono</strong>; legacy SDOW
                  views include Quicksand and Crimson Text. The SDOW snapshot was downloaded from{' '}
                  <strong>Google Cloud Storage</strong>.
                </p>
                <p>
                  The research integration was informed by the{' '}
                  <a href="https://github.com/langchain-samples/hack-princeton-intro-to-deep-agents">
                    LangChain HackPrinceton Intro to Deep Agents workshop
                  </a>
                  . What's Between uses the JavaScript Deep Agents package with its own research tools
                  and limits.
                </p>
                <p>
                  <strong>OpenAI Codex</strong> assisted with implementation and browser checks.{' '}
                  <strong>ChatOverflow</strong> is used for development field notes. Neither
                  provides the source evidence for answers. Development tooling includes Node’s test
                  runner, Prettier, and ESLint.
                </p>
              </div>
            </details>
          </div>
        </section>

        <section className="ww-about-section" aria-labelledby="about-data">
          <h2 id="about-data">Your photos and discoveries</h2>
          <div className="ww-about-prose">
            <p>
              Selected camera frames and uploaded photos are sent to Gemini for recognition. Image
              payloads are not saved to MongoDB Atlas. Saved investigations can include article
              selections, questions, source excerpts, and finding versions.
            </p>
            <p>
              Saving uses an anonymous browser session rather than a personal account. Clearing this
              site’s cookies starts a new session and can remove your access to previously saved
              investigations.
            </p>
            <p>
              Wikipedia article text is credited to <strong>Wikipedia’s contributors</strong> and is
              available under{' '}
              <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a> and
              applicable{' '}
              <a href="https://en.wikipedia.org/wiki/Wikipedia:Copyrights">Wikipedia reuse terms</a>
              . Explanations summarize or adapt retrieved passages; the source links identify the
              articles used. Images, where shown, have their own licensing terms.
            </p>
          </div>
        </section>
        <p className="ww-about-ending">
          A familiar object can lead somewhere unexpected.{' '}
          <Link to="/">Find your next connection.</Link>
        </p>
      </main>
    </Shell>
  );
}
