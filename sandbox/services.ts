/** Public catalog only. Lifecycle dispatch and authorization live in the Worker. */
export const SERVICES = [{
  id: 'openchamber',
  name: 'OpenChamber',
  description: 'A browser workspace for working with an AI agent: explore files, run commands, and build and preview projects. OpenChamber is the interface; OpenCode runs the agent, connected to BayLeaf.',
  endpoint: '/services/openchamber',
}] as const;
