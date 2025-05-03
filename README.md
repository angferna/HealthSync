# HealthSync
Big Data Indexing App - ElasticSearch, Redis, AND RabbitMQ with OAuth2.0

## Running the application
Make sure you have redis, RabbitMQ and ElasticSearch downloaded
  - start redis server: `brew services start redis`
  - start RabbitMQ server: `brew services start RabbitMQ`
  - start ElasticSearch server: `brew services start elasticsearch-full`
  - verify the server status: `redis-cli ping`
  - run the app: `node app.js`

  - stop redis server: `brew services stop redis`
  - stop RabbitMQ server: `brew services stop RabbitMQ`
  - stop ElasticSearch server: `brew services stop elasticsearch-full`
  - to delete all/existing plans: `curl -X DELETE http://localhost:9200/plans`
  
## Operations
POST `http://localhost:3001/v1/plan`
  - Use case in Body (raw)

GET `http://localhost:3001/v1/plan/12xvxc345ssdsds-508` {id}
  - Header -> If-None-Match (Key) -> {Etag} (Value)

DELETE `http://localhost:3001/v1/plan/12xvxc345ssdsds-508` {id}
  - Header -> If-None-Match (Key) -> {Etag} (Value)

PATCH `http://localhost:3002/v1/plan/12xvxc345ssdsds-508` {id}
  - Header -> If-Match (Key) -> {Etag} (Value)