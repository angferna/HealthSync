# HealthSync
Big Data Indexing App - ElasticSearch, Redis, AND RabbitMQ

## Running the application
Make sure you have redis downloaded
  - start redis server: `brew services start redis`
  - verify the server status: `redis-cli ping`
  - run the app: `node app.js`

## Operations
POST `http://localhost:3001/v1/plan`
  - Use case in Body (raw)

GET `http://localhost:3001/v1/plan/12xvxc345ssdsds-508` {id}
  - Header -> If-None-Match (Key) -> {Etag} (Value)

DELETE `http://localhost:3001/v1/plan/12xvxc345ssdsds-508` {id}
  - Header -> If-None-Match (Key) -> {Etag} (Value)

PATCH `http://localhost:3002/v1/plan/12xvxc345ssdsds-508` {id}
  - Header -> If-Match (Key) -> {Etag} (Value)