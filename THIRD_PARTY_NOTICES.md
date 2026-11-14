# Third-party notices

This integration is distributed under the Apache License 2.0 (see `LICENSE`).

## Gira IoT REST API v2 (protocol documentation)

- Source: "Gira IoT REST API v2", documentation of Gira Giersiepen GmbH & Co.
  KG, version v2 of 01.07.2020
  (https://download.gira.de/data3/Gira_IoT_REST_API_v2_DE.pdf, and the English
  edition `Gira_IoT_REST_API_v2_EN.pdf`).
- What was used: the routes, the registration, the error codes, the function
  and channel definitions and the shapes of the examples, to write the client
  and the simulated server of the tests. No text of the documentation is
  copied beyond the names of the API (routes, data point and channel names).

## Example clients (read, not used)

- https://github.com/EricHier/gira-iot-rest-api (MIT, Copyright (c) 2021 Eric
  Feltgen) was read as an example of the API calls only. No code is copied or
  ported from it (it skips the certificate check, which this integration
  replaces by a pin).

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
