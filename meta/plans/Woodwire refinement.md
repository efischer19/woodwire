# **Architecture Review & Refinement: Project Woodwire**

## **1\. Naming & Identity**

* **Formal Name:** **Project Woodwire** (Standard PascalCase for documentation and presentation).
* **Repository/CLI Name:** woodwire (Lowercase for strict POSIX compliance in GitHub repos, AWS resources, and terminal commands).
* **Rationale:** "Woodwire" evokes the imagery of a rugged, off-grid cabin wired directly to a local intelligence source. It signals a departure from bloated cloud SaaS, emphasizing bare-metal self-reliance, physical security boundaries, and asynchronous "dead drop" communication.

## **2\. Project Manifesto & Description**

**Woodwire** is an asynchronous, event-driven pipeline that establishes a highly secure, private communication channel between a user and a local AI agent. Built entirely on Cloudflare and AWS serverless infrastructure, it eliminates the need for traditional WebSockets or active server hosting.
Running a self-hosted AI interface traditionally requires exposing public ports and paying for 24/7 idle compute instances. Woodwire pivots to a "Dead Drop" architecture to solve this, providing:

* **Zero-Cost Operations:** Leverages AWS Free Tier and Cloudflare Workers to achieve a strict $0.00/month operating cost by eliminating idle compute waste.
* **Absolute Edge Security:** The local AI execution core initiates only *outbound* long-poll connections, meaning zero inbound network ports are opened. The local network remains entirely immune to external network scans, credential stuffing, or DDoS attacks.
* **Multimodal Capability:** Seamlessly handles text, image uploads, and native Voice Memos by treating all binary data abstractly through direct-to-S3 media pipelines.

## **3\. Key Architectural Decision Records (ADRs)**

To demonstrate senior-level engineering maturity to prospective employers, the bots will build this system governed by the following ADRs.

* **ADR 001: Asynchronous Queueing over WebSockets**
  * **Decision:** Utilize AWS SQS Long Polling instead of maintaining stateful WebSocket connections.
  * **Justification:** WebSockets require a permanently running server, incurring monthly compute costs and exposing an attack surface. SQS Long Polling achieves \<100ms response times while falling entirely under the AWS Free Tier, acting as an unhackable buffer.
* **ADR 002: Direct-to-S3 Pre-signed Uploads**
  * **Decision:** The frontend will request secure, temporary pre-signed URLs to upload media/audio directly into S3, rather than passing binary data through an API Gateway.
  * **Justification:** Bypasses API payload size limits and reduces execution time on the Cloudflare Worker, treating large voice memos and tiny text payloads with the same underlying infrastructure.
* **ADR 003: SQS Visibility Timeouts over Immediate Deletion**
  * **Decision:** The local bot will *hide* the SQS message upon receipt using a 60-second Visibility Timeout, and only permanently delete the message after a successful S3 write response.
  * **Justification:** Mitigates the risk of dropped payloads during heavy Text-to-Speech (TTS) generation. If the local script crashes mid-generation, the message returns to the queue automatically.
* **ADR 004: Polling Mitigation via Edge Caching**
  * **Decision:** The PWA will poll the Cloudflare Worker for completion status rather than hitting the S3 bucket directly.
  * **Justification:** Protects the AWS Free Tier constraints (20,000 free S3 GET requests/month). The Worker can track execution state or rate-limit the frontend without incurring AWS charges.

## **4\. Implementation Swimlanes (Epics)**

These epics cleanly divide the frontend/backend artifact separation and provide strict boundaries for bot-driven ticket generation.

* **Epic 1: Infrastructure & Edge Security**
  * Provision the AWS S3 bucket with isolated prefixes (inbox/, outbox/, attachments/) and a strict 48-hour lifecycle deletion policy.
  * Deploy the AWS SQS queue for the event buffer.
  * Implement the Cloudflare Worker to act as the API Gateway, handling custom passphrase authentication and AWS secret injection.
* **Epic 2: The Execution Core (Agent Backend)**
  * Develop the Python local consumer script to maintain the 20-second outbound SQS long-poll connection.
  * Implement the asynchronous processing loop: extract payload, run OpenClaw execution, write output to S3, and delete the SQS message.
  * Integrate the Voice Memo pipeline (Local STT transcription \-\> AI logic \-\> Local TTS generation).
* **Epic 3: The Woodwire PWA (Frontend)**
  * Build the static HTML/JS web portal served out of the private AWS S3 bucket, proxied via Cloudflare.
  * Integrate the native browser Web Audio API for microphone capture and direct .webm/.ogg uploads.
  * Implement the automated playback polling mechanism to retrieve the .mp3 AI response from the outbox.
* **Epic 4: CI/CD & Artifact Wiring**
  * Configure GitHub Actions (or equivalent) to build the frontend application.
  * Inject the necessary Terraform/Pulumi output variables (S3 bucket names, Worker endpoints) into the static bundle prior to deployment.
