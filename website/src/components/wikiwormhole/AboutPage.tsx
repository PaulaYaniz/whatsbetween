import {Link} from 'react-router-dom';

import {Shell} from './Shell';

import './wikiwormhole.css';
import './about.css';

const tools = [
  {
    name: 'Gemini',
    url: 'https://ai.google.dev/',
    use: 'names the objects in a photo and writes the explanations',
  },
  {
    name: 'Wikipedia API',
    url: 'https://www.mediawiki.org/wiki/API:Main_page',
    use: 'article search, current text and links',
  },
  {
    name: 'SDOW link graph',
    url: 'https://github.com/jwngr/sdow',
    use: 'a December 2023 copy of every Wikipedia link, used to find routes',
  },
  {
    name: 'LangChain Deep Agents',
    url: 'https://docs.langchain.com/oss/javascript/deepagents/overview',
    use: 'runs Dig deeper, with a fact-checker and a calculator helper',
  },
  {
    name: 'Wolfram Alpha',
    url: 'https://www.wolframalpha.com/',
    use: 'only when a question needs a number',
  },
  {name: 'MongoDB Atlas', url: 'https://www.mongodb.com/atlas', use: 'stores the research log'},
  {
    name: 'Cloudflare Workers',
    url: 'https://developers.cloudflare.com/workers/',
    use: 'runs the API (the interface is React)',
  },
];

export function AboutPage() {
  return (
    <Shell active="about">
      <title>About | What's Between</title>
      <main className="ww-main ww-about">
        <div className="ww-about-grid">
          <div>
            <h1>About</h1>
            <p className="ww-about-lead">
              What's Between takes two objects in front of you and shows how their Wikipedia
              articles connect.
            </p>
            <ol className="ww-about-steps">
              <li>
                Take or upload a photo. Pick two objects and check which article each one matches.
              </li>
              <li>See the topics both articles link to and the shortest route between them.</li>
              <li>Read a short explanation with its sources, or ask a question with Dig deeper.</li>
            </ol>
            <p className="ww-about-note">
              A shared link is a lead, not proof of a real-world connection. Explanations are
              generated and can be wrong, so check the linked sources.
            </p>
            <Link className="ww-button ww-button--dark ww-about-start" to="/">
              Scan two objects
            </Link>
          </div>

          <div className="ww-about-side">
            <section aria-labelledby="about-tools">
              <h2 id="about-tools">Built with</h2>
              <dl className="ww-about-tools">
                {tools.map((tool) => (
                  <div key={tool.name}>
                    <dt>
                      <a href={tool.url}>{tool.name}</a>
                    </dt>
                    <dd>{tool.use}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section aria-labelledby="about-data">
              <h2 id="about-data">Your data</h2>
              <p>
                Photos are sent to Gemini to be recognized; this app does not save them. The
                research log is tied to this browser, with no account. Clearing cookies loses access
                to it.
              </p>
            </section>

            <section aria-labelledby="about-credits">
              <h2 id="about-credits">Credits</h2>
              <p>
                Built on{' '}
                <a href="https://www.sixdegreesofwikipedia.com/">Six Degrees of Wikipedia</a> by
                Jacob Wenger (
                <a href="https://github.com/jwngr/sdow/blob/main/LICENSE">MIT License</a>). Article
                text by Wikipedia's contributors, under{' '}
                <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>.
              </p>
            </section>
          </div>
        </div>
      </main>
    </Shell>
  );
}
