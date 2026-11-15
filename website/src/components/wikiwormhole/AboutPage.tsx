import {Link} from 'react-router-dom';

import {Shell} from './Shell';

import './wikiwormhole.css';
import './about.css';

const tools = [
  {
    name: 'Gemini API',
    logo: '/logos/google-ai-studio.png',
    url: 'https://ai.google.dev/',
    use: 'Recognizes objects and explains links',
  },
  {
    name: 'Wikipedia API',
    logo: '/logos/wikipedia.svg',
    url: 'https://www.mediawiki.org/wiki/API:Main_page',
    use: 'Retrieves articles and source text',
  },
  {
    name: 'SDOW',
    logo: '/favicon-96x96.png',
    url: 'https://github.com/jwngr/sdow',
    use: 'Finds paths between article topics',
  },
  {
    name: 'LangChain',
    logo: '/logos/langchain.svg',
    url: 'https://docs.langchain.com/oss/javascript/deepagents/overview',
    use: 'Orchestrates Deep research agents',
  },
  {
    name: 'Wolfram Alpha',
    logo: '/logos/wolfram.svg',
    url: 'https://www.wolframalpha.com/',
    use: 'Calculates answers to numeric questions',
  },
  {
    name: 'MongoDB Atlas',
    logo: '/logos/mongodb.svg',
    url: 'https://www.mongodb.com/atlas',
    use: 'Saves findings and research evidence',
  },
  {
    name: 'Cloudflare Workers',
    logo: '/logos/cloudflare.svg',
    url: 'https://developers.cloudflare.com/workers/',
    use: 'Provides the backend API runtime',
  },
];

export function AboutPage() {
  return (
    <Shell active="about">
      <title>About | What’s Between…?</title>
      <main className="ww-main ww-about">
        <div className="ww-about-grid">
          <div>
            <h1>What’s Between…?</h1>
            <p className="ww-about-lead">
              Turn curiosity about your surroundings into discovery. Pick two
              everyday objects and explore the surprising ideas that connect them.
            </p>
            <ol className="ww-about-steps">
              <li>
                Scan your surroundings or upload a photo. Choose two objects that make you wonder.
              </li>
              <li>Explore connections through history, culture, science, and design.</li>
              <li>
                Ask a question with Deep research. AI agents investigate different angles, gather
                sources, and review their findings. Save your investigation and keep exploring.
              </li>
            </ol>
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
                      <a href={tool.url}>
                        <img
                          className="ww-about-logo"
                          src={tool.logo}
                          alt=""
                          width="20"
                          height="20"
                        />
                        <span>{tool.name}</span>
                      </a>
                    </dt>
                    <dd>{tool.use}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section aria-labelledby="about-data">
              <h2 id="about-data">Your data</h2>
              <p>
                Photos are processed by Gemini, not saved. Research stays linked to this browser;
                there are no accounts.
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
