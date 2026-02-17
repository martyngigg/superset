<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->

# Apache Superset Fork

This is a fork of [Apache Superset](https://github.com/apache/superset)
deployed in our [data platform stack](https://github.com/ISISNeutronMuon/analytics-data-platform).
It exists solely to allow for fixing bugs such that they can be deployed to
our users immediately without waiting for an official release.
Any fixes created here will also be be merged upstream if they still apply to the
master branch.

The default branch, v6, tracks branch 6.0 from the upstream repository.
Most bugs exist around the deployment of Superset under a non-empty application root -
this was introduced as a beta feature in v6. The aim is that by v7 we are able to use the
offical releases.

A GitHub action publishes a Docker image to this organizations packages repository when changes are
merged to the default v6 branch.
