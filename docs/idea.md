# Freeform Idea

Write naturally. One paragraph, fragments, pasted references, dislikes, examples, blank sections, and `idk` are all valid.

The human may use another repository file or the planning prompt instead. If a usable idea exists anywhere the human identifies, do not block planning because this file is empty.

## Notes

MarketPilot is an AI-native investing and trading platform designed around a continuously operating market agent. Instead of functioning as a traditional trading bot with one fixed strategy, MarketPilot acts more like a personalized portfolio manager, research analyst, and strategy coordinator. It continuously gathers market data, financial information, earnings releases, filings, news, technical signals, and portfolio activity, then combines that information to identify opportunities, interpret market developments, and make informed decisions.

At the core of MarketPilot is an intelligence platform that turns large amounts of fragmented market information into structured, usable insight. It can fetch real-time and historical data, calculate financial ratios and technical indicators, analyze earnings and valuation metrics, detect unusual market activity, summarize company filings, and connect news events to the companies, sectors, and assets they may affect. This intelligence can be used directly by a human investor through dashboards, research pages, alerts, and conversational analysis, or supplied to the AI agent as the foundation for its decisions.

The MarketPilot agent works across a library of investing and trading strategies rather than relying on a single model. Its available capabilities could include long-term investing, momentum, trend following, value and quality selection, earnings strategies, event-driven trading, mean reversion, portfolio rotation, options strategies, and other specialized approaches. The agent can compare these strategies, determine which are most appropriate for the current market environment, combine several into one portfolio, or activate pre-coded strategy processes that operate independently when faster or more systematic execution is required.

MarketPilot is intended to be highly customizable. Users could define their objectives, time horizon, preferred trading frequency, number of positions, asset classes, strategy preferences, portfolio concentration, and desired level of agent involvement. A user might request a diversified long-term portfolio, an aggressive six-month trading plan, a low-turnover income strategy, or an actively managed options portfolio. MarketPilot would translate those preferences into an evolving investment mandate and continuously adjust its research, opportunity selection, and strategy allocation around that mandate.

The product would maintain a live workspace containing the portfolio, active investment theses, watchlists, upcoming events, current strategies, and a ranked board of potential opportunities. Each position or proposed trade would have an explanation describing why it exists, what evidence supports it, what catalyst is expected, how long the opportunity may last, and what developments could change the agent’s view. Users could ask questions such as why a position was opened, what the strongest counterargument is, what the agent is currently investigating, or how recent news affects the portfolio.

A major part of MarketPilot would be its ability to learn from experience. The platform would record the information available at the time of each decision, the agent’s interpretation, the selected strategy, the expected outcome, the actual result, and the lessons drawn afterward. Over time, it could identify which strategies perform best under different conditions, where its forecasts tend to be too optimistic or too cautious, which information sources are most useful, and which types of opportunities are most suitable for the individual user.

MarketPilot could initially operate as a market-intelligence and portfolio-copilot product, providing research, recommendations, simulations, and paper trading. It could later expand into managed operation, where the agent continuously monitors the market, adjusts portfolios, launches strategy workers, and coordinates trade execution. The long-term vision is an adaptable market operating system that connects information, analytics, AI reasoning, systematic strategies, portfolio management, execution, and continuous learning in one unified product.

we could break it down by system responsibility, not by individual product screens or technologies. Each block should have clear inputs, outputs, and ownership.

A strong first-level breakdown would be:

1. Intelligence platform

Turns raw external information into reliable, queryable intelligence.

1a. Data and information acquisition

Fetches:

prices and market data;
financial statements;
earnings and estimates;
news and filings;
macro data;
options data;
portfolio and brokerage data.
1b. Normalization and entity resolution

Makes different sources consistent:

ticker and company mapping;
timestamps;
currencies;
split-adjusted prices;
duplicate news removal;
standardized financial fields.
1c. Deterministic analytics

Computes:

ratios and growth metrics;
technical indicators;
volatility and correlation;
valuation metrics;
options Greeks;
portfolio exposures;
event-surprise metrics.
1d. Intelligence extraction

Transforms unstructured information into structured facts:

event classification;
sentiment;
entities affected;
earnings guidance changes;
filing differences;
catalysts;
risks;
novelty and relevance.
1e. Intelligence storage and retrieval

Makes the processed information available to:

the agent;
users;
scanners;
strategies;
backtests;
monitoring workers.
2. Agent and reasoning platform

The main AI decision-making layer.

2a. Context builder

Assembles the relevant information for each task:

portfolio state;
user goals;
current opportunities;
market state;
recent events;
retrieved memories;
strategy outputs.
2b. Research and analysis agent

Investigates companies, markets, events, and trade ideas.

2c. Portfolio decision agent

Combines the evidence and decides whether to:

buy;
sell;
hold;
resize;
wait;
investigate further;
activate a strategy process.
2d. Agent orchestration

Lets the main agent call:

data tools;
analytical tools;
research workers;
specialist agents;
strategy modules;
simulations.
2e. Explanation layer

Produces:

concise explanations;
detailed theses;
decision timelines;
answers to user questions.
3. Strategy platform

Contains reusable trading and investing capabilities.

3a. Strategy library

Examples:

momentum;
trend;
value;
quality;
earnings;
mean reversion;
options;
portfolio allocation.
3b. Strategy configuration

Controls:

parameters;
universe;
time horizon;
trading frequency;
number of positions;
capital allocation.
3c. Strategy composition

Allows the agent or user to combine primitives such as:

filter;
score;
rank;
entry;
exit;
sizing;
execution.
3d. Backtesting and simulation

Tests strategies using historical or live simulated data.

3e. Live strategy workers

Runs pre-coded strategies continuously when activated by the agent or user.

4. Portfolio and decision platform

Converts ideas into a coherent portfolio.

4a. Opportunity management

Stores candidate investments and trades with:

thesis;
evidence;
horizon;
confidence;
catalyst;
status.
4b. Position and thesis management

Tracks why each position exists and whether that reasoning remains valid.

4c. Portfolio construction

Decides:

which opportunities to include;
how much capital to allocate;
how many positions to hold;
how strategies interact.
4d. Goal planning

Converts user objectives into:

strategy preferences;
portfolio style;
expected path;
target horizon;
required activity level.
4e. Scenario analysis

Compares possible portfolio paths and strategy combinations.

5. Trading and automation platform

Turns portfolio decisions into actions.

5a. Order planning

Converts target positions into proposed trades.

5b. Execution algorithms

Examples:

immediate execution;
staged execution;
TWAP;
passive-first;
liquidity-sensitive execution.
5c. Broker integration

Handles:

account state;
orders;
fills;
cancellations;
positions;
cash.
5d. Fast deterministic workers

Runs processes that the AI itself is too slow to perform:

intraday entry logic;
order monitoring;
execution adjustment;
predefined fast strategies.
5e. Scheduling and event triggers

Starts workflows based on:

market schedules;
earnings;
news;
price changes;
portfolio changes;
strategy signals.
6. Memory and learning platform

Stores experience and improves future behavior.

6a. Company memory

Persistent knowledge about individual companies.

6b. Market and theme memory

Tracks sectors, narratives, macro regimes, and recurring patterns.

6c. Trade and decision memory

Stores:

what the agent believed;
what it predicted;
what action it took;
what happened afterward.
6d. Strategy performance memory

Measures which strategies performed well under which conditions.

6e. Reflection and learning

Runs:

post-trade reviews;
daily reviews;
weekly strategy reviews;
lessons and hypothesis generation.
6f. Evaluation and adaptation

Adjusts things such as:

strategy weights;
confidence calibration;
preferred data sources;
opportunity ranking;
trade thresholds.
7. Product experience

The user-facing layer.

7a. Onboarding and mandate creation

Captures goals and preferences.

7b. Dashboard

Shows portfolio, opportunities, strategies, agent activity, and events.

7c. Chat and command interface

Lets users ask questions and direct the agent.

7d. Research workspace

Contains company reports, event analyses, watchlists, and notes.

7e. Strategy builder

Allows strategies to be created or modified visually or through language.

7f. Notifications and reports

Daily briefings, alerts, position updates, and weekly reviews.

8. Core platform infrastructure

Supports all other blocks.

8a. Databases and event system
8b. Tool and service interfaces
8c. Workflow engine
8d. Logging and observability
8e. Model and prompt management
8f. Testing and evaluation infrastructure
