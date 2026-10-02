/**
 * Background processors. Each file registers its processors and schedules with
 * the worker runtime. Importing this module wires everything up.
 */
import './notifications';
import './maintenance';
import './sla';
import './tickets';
import './contracts';
import './pm';
import './reports';
import './discovery';
import './integrations';
import './metrics';
