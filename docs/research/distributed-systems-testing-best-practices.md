# Best Practices for Testing Distributed Systems and Network Protocols

> Research compiled for AWCP project - TypeScript/Node.js recommendations

## Table of Contents

1. [How Major Projects Test Failure Scenarios](#1-how-major-projects-test-failure-scenarios)
2. [Common Testing Patterns](#2-common-testing-patterns)
3. [Tools and Frameworks for Fault Injection](#3-tools-and-frameworks-for-fault-injection)
4. [CI/CD Considerations](#4-cicd-considerations)
5. [Actionable Recommendations for TypeScript/Node.js](#5-actionable-recommendations-for-typescriptnodejs)

---

## 1. How Major Projects Test Failure Scenarios

### Jepsen Approach (etcd, Kafka, MongoDB, Redis, etc.)

[Jepsen](https://jepsen.io/) by Kyle Kingsbury is the gold standard for distributed systems testing. Key techniques:

- **Black-box testing**: Tests real binaries on real clusters without requiring source access
- **Failure injection under realistic conditions**: Network partitions, clock skew, partial node failures
- **Generative testing**: Random operations with verification against a correctness model
- **Linearizability checking**: Verifies operations appear atomic and in some sequential order

**Notable findings**: Jepsen has tested 40+ systems including etcd (3.4.3), Kafka (0.8), MongoDB (multiple versions), Redis, PostgreSQL, MySQL, and found bugs in nearly all of them.

**Key insight**: Even rigorously-tested systems like etcd have edge cases. Testing must be continuous and comprehensive.

### Netflix Chaos Engineering (arXiv:1702.05843, arXiv:1905.04648)

Netflix pioneered chaos engineering with these principles:

1. **Start with a steady state hypothesis**: Define what "normal" looks like
2. **Vary real-world events**: Inject failures that actually happen in production
3. **Run experiments in production**: Real traffic, real infrastructure
4. **Automate experiments**: Continuous verification of resilience
5. **Minimize blast radius**: Start small, expand carefully

**Implementation**:
- Chaos Automation Platform (CAP) automatically generates and executes experiments
- Verifies non-critical service failures don't cascade to outages
- Uses production traffic for realistic validation

### gRPC Testing Approach

gRPC uses multiple testing layers:
- **Unit tests** with mock transport layers
- **Integration tests** with in-process servers
- **Interoperability tests** across language implementations
- **Stress tests** for race conditions and resource leaks

### Mallory: Greybox Fuzzing (arXiv:2305.02601)

A newer academic approach that found 22 zero-day bugs in Braft, Dqlite, Redis:

- Uses **Lamport timelines** to track happens-before relationships
- **Q-learning** to intelligently select fault injection sequences
- Outperforms Jepsen by exploring more behaviors faster

---

## 2. Common Testing Patterns

### Network Partitions

**Simulation approaches**:

```typescript
// Pattern 1: Proxy-based (Toxiproxy)
// Route connections through proxy, then sever/delay at will
const proxy = await toxiproxy.createProxy({
  name: 'redis',
  listen: 'localhost:26379',
  upstream: 'localhost:6379'
});
await proxy.setEnabled(false); // Simulate partition

// Pattern 2: Mock transport layer
// Replace network layer with controllable mock
class MockTransport implements TransportAdapter {
  private partitioned = new Set<string>();
  
  async send(peerId: string, message: Message) {
    if (this.partitioned.has(peerId)) {
      throw new Error('Connection refused');
    }
    // Normal send logic
  }
  
  partition(peerId: string) {
    this.partitioned.add(peerId);
  }
}
```

**What to test**:
- Split-brain scenarios (leader on each side of partition)
- Partition during in-flight requests
- Asymmetric partitions (A→B works, B→A doesn't)
- Partition heal timing

### Timeouts

**Key patterns**:

```typescript
// Pattern 1: Fake timers (Vitest/Jest)
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('timeout handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should timeout after configured duration', async () => {
    const promise = client.request('/slow-endpoint');
    
    // Fast-forward past timeout
    await vi.advanceTimersByTimeAsync(5000);
    
    await expect(promise).rejects.toThrow('Timeout');
  });
});

// Pattern 2: Controllable delays (Toxiproxy)
await proxy.addToxic({
  name: 'latency',
  type: 'latency',
  attributes: { latency: 10000 } // 10 second delay
});

// Pattern 3: AbortController for request cancellation
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

try {
  await fetch(url, { signal: controller.signal });
} catch (error) {
  if (error.name === 'AbortError') {
    // Handle timeout
  }
}
```

### Partial Failures

**Scenarios to test**:

```typescript
// Pattern 1: Intermittent failures with toxicity
await proxy.addToxic({
  type: 'timeout',
  toxicity: 0.3, // 30% of connections fail
  attributes: { timeout: 0 }
});

// Pattern 2: Failure after partial response
const mockServer = http.createServer((req, res) => {
  res.write('partial data...');
  req.destroy(); // Abrupt close
});

// Pattern 3: nock/msw for HTTP mocking
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  http.get('/api/data', ({ request }) => {
    // Fail every third request
    if (requestCount++ % 3 === 0) {
      return HttpResponse.error();
    }
    return HttpResponse.json({ data: 'success' });
  })
);

// Pattern 4: Connection reset simulation
nock('http://api.example.com')
  .get('/resource')
  .replyWithError({
    code: 'ECONNRESET',
    message: 'Connection reset by peer'
  });
```

### Message Ordering Issues

**Test patterns for out-of-order delivery**:

```typescript
// Pattern 1: Reordering queue
class ReorderingTransport implements Transport {
  private queue: Message[] = [];
  
  async send(msg: Message) {
    this.queue.push(msg);
    // Randomly reorder
    this.queue.sort(() => Math.random() - 0.5);
    await this.flush();
  }
}

// Pattern 2: Deterministic reordering with seed
import seedrandom from 'seedrandom';

class DeterministicReorderTransport {
  private rng: seedrandom.PRNG;
  
  constructor(seed: string) {
    this.rng = seedrandom(seed);
  }
  
  reorder<T>(items: T[]): T[] {
    return [...items].sort(() => this.rng() - 0.5);
  }
}

// Pattern 3: Test idempotency
it('should handle duplicate messages', async () => {
  await handler.process(message);
  await handler.process(message); // Same message again
  // Should not cause inconsistent state
});
```

### Reconnection Logic

```typescript
describe('reconnection', () => {
  it('should reconnect with exponential backoff', async () => {
    vi.useFakeTimers();
    
    const client = new Client({ maxRetries: 3 });
    const connectSpy = vi.spyOn(client, 'connect');
    
    // Simulate connection failures
    mockServer.rejectConnections(3);
    
    const connectPromise = client.connectWithRetry();
    
    // First attempt fails immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    
    // Second attempt after 1s backoff
    await vi.advanceTimersByTimeAsync(1000);
    expect(connectSpy).toHaveBeenCalledTimes(2);
    
    // Third attempt after 2s backoff
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectSpy).toHaveBeenCalledTimes(3);
    
    // Allow final success
    mockServer.acceptConnections();
    await vi.advanceTimersByTimeAsync(4000);
    
    await connectPromise;
    expect(client.isConnected()).toBe(true);
    
    vi.useRealTimers();
  });

  it('should preserve state across reconnection', async () => {
    // Subscribe before disconnect
    await client.subscribe('channel');
    
    // Force disconnect
    await mockServer.disconnectAll();
    
    // Wait for reconnect
    await vi.waitFor(() => client.isConnected());
    
    // Subscription should be restored
    expect(client.subscriptions).toContain('channel');
  });
});
```

---

## 3. Tools and Frameworks for Fault Injection

### Toxiproxy (Shopify)

**Best for**: TCP-level fault injection in integration tests

```bash
# Install
brew install toxiproxy  # macOS
# or Docker
docker run -p 8474:8474 ghcr.io/shopify/toxiproxy

# Create proxy
toxiproxy-cli create -l localhost:26379 -u localhost:6379 redis
```

**Node.js client**: [toxiproxy-node-client](https://github.com/ihsw/toxiproxy-node-client)

```typescript
import { Toxiproxy } from 'toxiproxy-node-client';

const toxiproxy = new Toxiproxy('http://localhost:8474');

// Setup proxy
const proxy = await toxiproxy.createProxy({
  name: 'my-service',
  listen: 'localhost:8080',
  upstream: 'actual-service:8080'
});

// Available toxics:
// - latency: Add delay (with jitter)
// - bandwidth: Limit throughput (KB/s)
// - slow_close: Delay connection close
// - timeout: Stop data, optionally close after delay
// - reset_peer: Simulate TCP RST
// - slicer: Fragment packets
// - limit_data: Close after N bytes

await proxy.addToxic({
  name: 'latency',
  type: 'latency',
  stream: 'downstream', // or 'upstream'
  toxicity: 1.0,        // probability (0-1)
  attributes: {
    latency: 1000,      // ms
    jitter: 100         // +/- ms
  }
});

// Cleanup
await proxy.remove();
```

### nock (HTTP Mocking for Node.js)

**Best for**: Unit/integration testing of HTTP clients

```typescript
import nock from 'nock';

describe('API client', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('should handle server errors', async () => {
    nock('https://api.example.com')
      .get('/users')
      .reply(500, { error: 'Internal Server Error' });

    await expect(client.getUsers()).rejects.toThrow('Server error');
  });

  it('should handle network errors', async () => {
    nock('https://api.example.com')
      .get('/users')
      .replyWithError({ code: 'ETIMEDOUT' });

    await expect(client.getUsers()).rejects.toThrow('Network error');
  });

  it('should handle delayed responses', async () => {
    nock('https://api.example.com')
      .get('/users')
      .delay(5000)  // 5 second delay
      .reply(200, { users: [] });

    // With fake timers, this won't actually wait
  });

  it('should retry on failure', async () => {
    nock('https://api.example.com')
      .get('/users')
      .times(2)
      .reply(503)
      .get('/users')
      .reply(200, { users: ['alice'] });

    const result = await client.getUsersWithRetry();
    expect(result.users).toEqual(['alice']);
  });
});
```

### MSW (Mock Service Worker)

**Best for**: API mocking that works in both browser and Node.js

```typescript
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';

const handlers = [
  http.get('/api/user', async () => {
    await delay(100);  // Realistic latency
    return HttpResponse.json({ name: 'John' });
  }),

  http.post('/api/submit', async ({ request }) => {
    // Simulate random failures
    if (Math.random() < 0.3) {
      return HttpResponse.error();
    }
    return HttpResponse.json({ success: true });
  }),

  // Network error
  http.get('/api/flaky', () => {
    return HttpResponse.error();
  }),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Override for specific test
it('handles timeout', async () => {
  server.use(
    http.get('/api/user', async () => {
      await delay('infinite');  // Never responds
    })
  );
  
  // Test with AbortController timeout
});
```

### Testcontainers

**Best for**: Integration tests with real services (databases, message queues)

```typescript
import { GenericContainer, Wait } from 'testcontainers';

describe('Database integration', () => {
  let container;
  let connectionUrl;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:15')
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'testdb'
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready'))
      .start();

    connectionUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  }, 60000);

  afterAll(async () => {
    await container.stop();
  });

  it('should handle database operations', async () => {
    const db = new Database(connectionUrl);
    await db.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
    const result = await db.query('SELECT * FROM users');
    expect(result.rows).toHaveLength(1);
  });
});
```

### Vitest Fake Timers

**Best for**: Deterministic timeout and scheduling tests

```typescript
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Retry logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should implement exponential backoff', async () => {
    const retryFn = vi.fn().mockRejectedValue(new Error('fail'));
    
    const promise = retryWithBackoff(retryFn, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000
    });

    // Attempt 1 (immediate)
    await vi.advanceTimersByTimeAsync(0);
    expect(retryFn).toHaveBeenCalledTimes(1);

    // Attempt 2 (after 1000ms)
    await vi.advanceTimersByTimeAsync(1000);
    expect(retryFn).toHaveBeenCalledTimes(2);

    // Attempt 3 (after 2000ms more)
    await vi.advanceTimersByTimeAsync(2000);
    expect(retryFn).toHaveBeenCalledTimes(3);

    // Final attempt (after 4000ms more)
    await vi.advanceTimersByTimeAsync(4000);
    expect(retryFn).toHaveBeenCalledTimes(4);

    await expect(promise).rejects.toThrow();
  });
});
```

---

## 4. CI/CD Considerations

### Should Failure Tests Run in CI?

**Yes, but stratified**:

| Test Type | When to Run | Why |
|-----------|-------------|-----|
| Unit tests with mocks | Every commit | Fast, deterministic |
| Integration with Toxiproxy | Every PR | Catches protocol bugs |
| Full Testcontainers suite | Nightly / PR to main | Slower, but realistic |
| Chaos experiments | Staging only | Too unpredictable for CI |

### Making Tests Deterministic

**1. Seeded randomness**:

```typescript
import seedrandom from 'seedrandom';

class DeterministicFaultInjector {
  private rng: seedrandom.PRNG;
  
  constructor(seed = process.env.TEST_SEED || 'default-seed') {
    this.rng = seedrandom(seed);
    console.log(`[FaultInjector] Using seed: ${seed}`);
  }

  shouldFail(probability: number): boolean {
    return this.rng() < probability;
  }
}
```

**2. Controlled timing with fake timers**:

```typescript
// Instead of:
await new Promise(resolve => setTimeout(resolve, 1000));

// Use:
await vi.advanceTimersByTimeAsync(1000);
```

**3. Explicit ordering**:

```typescript
// Instead of racing promises:
await Promise.race([operation1(), operation2()]);

// Use controlled execution:
const op1Promise = operation1();
await vi.advanceTimersByTimeAsync(100);
const op2Promise = operation2();
await Promise.all([op1Promise, op2Promise]);
```

**4. Reproducible test runs**:

```bash
# CI script
export TEST_SEED=$(date +%s)
echo "Test seed: $TEST_SEED"
npm test

# If tests fail, rerun with same seed
TEST_SEED=1699999999 npm test
```

### Test Isolation Strategies

**1. Port allocation**:

```typescript
import getPort from 'get-port';

let serverPort: number;
let proxyPort: number;

beforeAll(async () => {
  serverPort = await getPort();
  proxyPort = await getPort();
  
  await startServer({ port: serverPort });
  await toxiproxy.createProxy({
    listen: `localhost:${proxyPort}`,
    upstream: `localhost:${serverPort}`
  });
});
```

**2. Cleanup hooks**:

```typescript
afterEach(async () => {
  // Reset all proxies to clean state
  await toxiproxy.reset();
  
  // Clear nock interceptors
  nock.cleanAll();
  
  // Reset MSW handlers
  server.resetHandlers();
});

afterAll(async () => {
  await toxiproxy.deleteAll();
  await container?.stop();
});
```

**3. Parallel test isolation**:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    // Run test files in parallel, but tests within files sequentially
    fileParallelism: true,
    sequence: {
      concurrent: false  // Tests in same file run sequentially
    },
    
    // Isolate global state
    isolate: true,
    
    // Pool for test isolation
    pool: 'forks'  // vs 'threads' - better isolation
  }
});
```

**4. Resource namespacing**:

```typescript
// Use unique identifiers per test file/worker
const testId = `test-${process.pid}-${Date.now()}`;

const proxy = await toxiproxy.createProxy({
  name: `redis-${testId}`,
  listen: `localhost:${await getPort()}`,
  upstream: 'localhost:6379'
});
```

---

## 5. Actionable Recommendations for TypeScript/Node.js

### Recommended Test Structure

```
tests/
├── unit/                    # Fast, no I/O
│   ├── state-machine.test.ts
│   └── message-parsing.test.ts
├── integration/             # With mocks/fakes
│   ├── http-client.test.ts  # nock
│   └── transport.test.ts    # mock transport
├── e2e/                     # Real services
│   ├── database.test.ts     # Testcontainers
│   └── full-flow.test.ts    # Docker Compose
└── chaos/                   # Fault injection
    ├── network-partition.test.ts
    └── timeout-scenarios.test.ts
```

### Package Recommendations

```json
{
  "devDependencies": {
    "vitest": "^2.0.0",
    "nock": "^13.5.0",
    "msw": "^2.0.0",
    "testcontainers": "^10.0.0",
    "toxiproxy-node-client": "^2.0.0",
    "get-port": "^7.0.0",
    "seedrandom": "^3.0.5"
  }
}
```

### Sample Test Setup

```typescript
// test/setup.ts
import { vi, beforeAll, afterAll, afterEach } from 'vitest';
import { Toxiproxy } from 'toxiproxy-node-client';
import nock from 'nock';

// Global toxiproxy client
export const toxiproxy = new Toxiproxy('http://localhost:8474');

// Ensure clean state
beforeAll(async () => {
  // Check if Toxiproxy is available (skip if not)
  try {
    await toxiproxy.getAll();
  } catch {
    console.warn('Toxiproxy not available, some tests will be skipped');
  }
});

afterEach(async () => {
  nock.cleanAll();
  
  try {
    await toxiproxy.reset();
  } catch {
    // Toxiproxy not available
  }
});

afterAll(async () => {
  try {
    const proxies = await toxiproxy.getAll();
    await Promise.all(proxies.map(p => p.remove()));
  } catch {
    // Toxiproxy not available
  }
});

// Vitest config
export default {
  setupFiles: ['./test/setup.ts'],
  testTimeout: 30000,
  hookTimeout: 30000,
};
```

### Example: Complete Failure Test Suite

```typescript
// tests/chaos/network-failures.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Toxiproxy, Proxy } from 'toxiproxy-node-client';
import getPort from 'get-port';
import { Client } from '../../src/client';

describe('Network failure handling', () => {
  let toxiproxy: Toxiproxy;
  let proxy: Proxy;
  let proxyPort: number;
  let client: Client;

  beforeAll(async () => {
    toxiproxy = new Toxiproxy('http://localhost:8474');
    proxyPort = await getPort();
    
    proxy = await toxiproxy.createProxy({
      name: 'test-service',
      listen: `localhost:${proxyPort}`,
      upstream: 'localhost:3000'
    });
  });

  afterAll(async () => {
    await proxy?.remove();
  });

  beforeEach(async () => {
    await proxy.removeAllToxics();
    client = new Client({ 
      url: `http://localhost:${proxyPort}`,
      timeout: 5000
    });
  });

  describe('latency', () => {
    it('should handle slow responses', async () => {
      vi.useFakeTimers();
      
      await proxy.addToxic({
        type: 'latency',
        attributes: { latency: 3000 }
      });

      const requestPromise = client.request('/data');
      
      // Advance past latency
      await vi.advanceTimersByTimeAsync(3100);
      
      const result = await requestPromise;
      expect(result).toBeDefined();
      
      vi.useRealTimers();
    });

    it('should timeout on excessive latency', async () => {
      await proxy.addToxic({
        type: 'latency',
        attributes: { latency: 10000 }
      });

      await expect(client.request('/data')).rejects.toThrow('timeout');
    });
  });

  describe('connection failures', () => {
    it('should handle connection refused', async () => {
      await proxy.setEnabled(false);
      
      await expect(client.request('/data')).rejects.toThrow(/ECONNREFUSED/);
    });

    it('should handle connection reset', async () => {
      await proxy.addToxic({
        type: 'reset_peer',
        attributes: { timeout: 100 }
      });

      await expect(client.request('/data')).rejects.toThrow(/ECONNRESET/);
    });
  });

  describe('partial failures', () => {
    it('should handle intermittent failures', async () => {
      await proxy.addToxic({
        type: 'timeout',
        toxicity: 0.5, // 50% of requests fail
        attributes: { timeout: 0 }
      });

      let successes = 0;
      let failures = 0;

      for (let i = 0; i < 10; i++) {
        try {
          await client.request('/data');
          successes++;
        } catch {
          failures++;
        }
      }

      // With 50% failure rate, expect mix of results
      expect(successes).toBeGreaterThan(0);
      expect(failures).toBeGreaterThan(0);
    });

    it('should retry and eventually succeed', async () => {
      let attempts = 0;
      
      await proxy.addToxic({
        type: 'timeout',
        toxicity: 0.7, // 70% fail
        attributes: { timeout: 0 }
      });

      // Client with retry logic should eventually succeed
      const result = await client.requestWithRetry('/data', {
        maxRetries: 10,
        onRetry: () => attempts++
      });

      expect(result).toBeDefined();
      expect(attempts).toBeGreaterThan(0);
    });
  });

  describe('bandwidth limits', () => {
    it('should handle slow connections', async () => {
      await proxy.addToxic({
        type: 'bandwidth',
        attributes: { rate: 1 } // 1 KB/s
      });

      const start = Date.now();
      await client.request('/large-data'); // Assume 5KB response
      const duration = Date.now() - start;

      // Should take ~5 seconds at 1 KB/s
      expect(duration).toBeGreaterThan(4000);
    });
  });
});
```

### CI Pipeline Example

```yaml
# .github/workflows/test.yml
name: Test Suite

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:unit

  integration-tests:
    runs-on: ubuntu-latest
    services:
      toxiproxy:
        image: ghcr.io/shopify/toxiproxy
        ports:
          - 8474:8474
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:integration
        env:
          TEST_SEED: ${{ github.run_id }}

  e2e-tests:
    runs-on: ubuntu-latest
    # Only on main branch or release
    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:e2e
        env:
          TESTCONTAINERS_RYUK_DISABLED: false
```

---

## Summary

### Key Takeaways

1. **Layer your tests**: Unit → Integration → E2E → Chaos
2. **Use the right tool for the job**:
   - **nock/msw**: HTTP mocking for client code
   - **Toxiproxy**: TCP-level fault injection
   - **Testcontainers**: Real service integration
   - **Fake timers**: Deterministic timeout testing
3. **Make tests deterministic**: Seed random, control time, isolate resources
4. **Run failure tests in CI**: But gate expensive tests to appropriate triggers
5. **Design for testability**: Dependency injection, configurable timeouts, retry policies

### References

- [Jepsen Analyses](https://jepsen.io/analyses)
- [Toxiproxy](https://github.com/Shopify/toxiproxy)
- [nock](https://github.com/nock/nock)
- [MSW](https://mswjs.io/)
- [Testcontainers Node](https://node.testcontainers.org/)
- Netflix Chaos Engineering (arXiv:1702.05843)
- Greybox Fuzzing of Distributed Systems (arXiv:2305.02601)
- Chaos Engineering in the Wild (arXiv:2505.13654)
