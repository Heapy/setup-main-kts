@file:DependsOn("org.apache.commons:commons-lang3:3.18.0")
@file:Import("shared.main.kts")

import org.apache.commons.lang3.StringUtils

check(args.single() == "argument with spaces")
check(StringUtils.capitalize(greeting) == "Main-kts works")
println("Main-kts works")
